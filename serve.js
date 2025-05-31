require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcrypt');
const winston = require('winston');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const NodeCache = require('node-cache');
const WebSocket = require('ws');
const app = express();
const port = process.env.PORT || 5500;

// 設置日誌記錄
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} [${level.toUpperCase()}]: ${message}`;
        })
    ),
    transports: [
        new winston.transports.File({ filename: 'logs/app.log' }),
        new winston.transports.Console()
    ]
});

// 設置緩存
const cache = new NodeCache({ stdTTL: 600 });

// 設置圖片儲存路徑（改為專案根目錄下的 images）
const uploadDir = path.join(__dirname, '..', 'images');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// 配置 multer 儲存圖片（使用臨時檔名，稍後重新命名）
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `temp-${uniqueSuffix}.jpg`);
    }
});
const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
            return cb(new Error('只允許上傳圖片檔案！'), false);
        }
        cb(null, true);
    },
    limits: { fileSize: 5 * 1024 * 1024 }
});

// 中間件設置
app.use(bodyParser.json());
app.use(express.json());
app.use(cors({
    origin: ['http://127.0.0.1:5500', 'http://localhost:5500'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true
}));
app.use(express.static(path.join(__dirname, '..'))); // 提供根目錄的靜態檔案

// 身份驗證中間件
const authenticate = (req, res, next) => {
    const isLoggedIn = req.headers.authorization === 'Bearer true';
    if (!isLoggedIn) {
        logger.warn('未授權訪問，受保護的路由');
        return res.status(401).json({ error: '未登入，請先登入' });
    }
    next();
};

// 錯誤處理中間件
app.use((err, req, res, next) => {
    logger.error(`未捕獲的錯誤: ${err.message}`);
    res.status(500).json({ error: '伺服器內部錯誤' });
});

// 連接到 SQLite 資料庫
const dbPath = process.env.DB_PATH || './志學燒肉飯.db';
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => {
    if (err) {
        logger.error(`無法連接到資料庫: ${err.message}`);
        process.exit(1);
    } else {
        logger.info('已連接到資料庫');
    }
});

// 初始化資料庫
const dbInit = new Promise((resolve, reject) => {
    db.serialize(() => {
        // 創建 Users 表
        db.run(`CREATE TABLE IF NOT EXISTS Users (
            UserID INTEGER PRIMARY KEY AUTOINCREMENT,
            Username TEXT NOT NULL UNIQUE,
            Password TEXT NOT NULL,
            Email TEXT NOT NULL UNIQUE,
            Phone TEXT NOT NULL UNIQUE,
            FullName TEXT NOT NULL,
            CreatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            ResetToken TEXT,
            ResetTokenExpiry DATETIME
        )`, (err) => {
            if (err) {
                logger.error(`創建 Users 表失敗: ${err.message}`);
                reject(err);
            } else {
                logger.info('Users 表已創建');
                db.get('SELECT COUNT(*) AS count FROM Users WHERE Username = ?', ['eric'], (err, row) => {
                    if (err) {
                        logger.error(`檢查預設用戶失敗: ${err.message}`);
                        reject(err);
                    }
                    if (row.count === 0) {
                        const saltRounds = 10;
                        bcrypt.hash('123', saltRounds, (err, hash) => {
                            if (err) {
                                logger.error(`密碼加密失敗: ${err.message}`);
                                reject(err);
                            }
                            db.run(`INSERT INTO Users (Username, Password, Email, Phone, FullName) VALUES (?, ?, ?, ?, ?)`,
                                ['eric', hash, 'eric@example.com', '0912345678', 'Eric Chen'], (err) => {
                                    if (err) {
                                        logger.error(`插入預設用戶失敗: ${err.message}`);
                                        reject(err);
                                    } else {
                                        logger.info('預設用戶已創建: eric');
                                    }
                                });
                        });
                    } else {
                        logger.info('預設用戶已存在，跳過插入');
                    }
                });
            }
        });

        // 創建 Store_Schedule 表並批量插入數據
        db.run(`CREATE TABLE IF NOT EXISTS Store_Schedule (
                Date TEXT PRIMARY KEY,
                DayOfWeek TEXT NOT NULL,
                MorningStart TIME,
                MorningEnd TIME,
                EveningStart TIME,
                EveningEnd TIME,
                IsClosedToday BOOLEAN DEFAULT 0,
                StoreName TEXT,
                Address TEXT
            )`, (err) => {
                if (err) {
                    logger.error(`創建 Store_Schedule 表失敗: ${err.message}`);
                    reject(err);
                } else {
                    logger.info('Store_Schedule 表已創建');
                    db.run(`CREATE INDEX IF NOT EXISTS idx_date ON Store_Schedule (Date)`, (err) => {
                        if (err) {
                            logger.error(`創建索引失敗: ${err.message}`);
                            reject(err);
                        }
                    });

                    // 動態檢查並生成當前年份的資料
                    const currentYear = new Date().getFullYear();
                    const startDate = new Date(`${currentYear}-01-01`);
                    const endDate = new Date(`${currentYear}-12-31`);
                    const defaultSchedule = {
                        '星期四': ['11:30', '13:30', '16:30', '20:00', 0],
                        '星期五': ['11:30', '13:30', '16:30', '20:00', 0],
                        '星期六': [null, null, null, null, 1],
                        '星期日': ['11:30', '13:30', '16:30', '20:00', 0],
                        '星期一': ['11:30', '13:30', '16:30', '20:00', 0],
                        '星期二': ['11:30', '13:30', '16:30', '20:00', 0],
                        '星期三': ['11:30', '13:30', '16:30', '20:00', 0]
                    };

                    const stmt = db.prepare(`INSERT OR IGNORE INTO Store_Schedule (Date, DayOfWeek, MorningStart, MorningEnd, EveningStart, EveningEnd, IsClosedToday, StoreName, Address) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
                    for (let date = new Date(startDate); date <= endDate; date.setDate(date.getDate() + 1)) {
                        const dateStr = date.toISOString().split('T')[0];
                        const dayOfWeek = date.toLocaleDateString('zh-TW', { weekday: 'long' });
                        const [morningStart, morningEnd, eveningStart, eveningEnd, isClosed] = defaultSchedule[dayOfWeek];
                        stmt.run([dateStr, dayOfWeek, morningStart, morningEnd, eveningStart, eveningEnd, isClosed, '幸福小吃', '台北市中正區幸福路123號']);
                    }
                    stmt.finalize((err) => {
                        if (err) {
                            logger.error(`插入 Store_Schedule 數據失敗: ${err.message}`);
                            reject(err);
                        } else {
                            logger.info('Store_Schedule 初始數據已創建或更新');
                        }
                    });
                }
            });

        // 創建 Menu_Items 表
        db.run(`CREATE TABLE IF NOT EXISTS Menu_Items (
            ItemID INTEGER PRIMARY KEY,
            Category TEXT NOT NULL,
            Item_Name TEXT NOT NULL,
            Price INTEGER NOT NULL,
            Status TEXT NOT NULL DEFAULT '供應中'
        )`, (err) => {
            if (err) {
                logger.error(`創建 Menu_Items 表失敗: ${err.message}`);
                reject(err);
            } else {
                logger.info('Menu_Items 表已創建');
                db.get('SELECT COUNT(*) AS count FROM Menu_Items', (err, row) => {
                    if (err) {
                        logger.error(`檢查 Menu_Items 數據失敗: ${err.message}`);
                        reject(err);
                    } else if (row.count === 0) {
                        const initialItems = [
                            { ItemID: 101, Category: 'Bento', Item_Name: '雙拼特餐A (本幫+燒肉)', Price: 100, Status: '供應中' },
                            { ItemID: 102, Category: 'Bento', Item_Name: '雙拼特餐B (里肌+燒肉)', Price: 100, Status: '供應中' },
                            { ItemID: 201, Category: 'Noodles', Item_Name: '沙茶炒麵', Price: 50, Status: '本日售完' },
                            { ItemID: 301, Category: 'Side_Dishes', Item_Name: '椒鹽香雞排', Price: 70, Status: '供應中' }
                        ];
                        db.serialize(() => {
                            const stmt = db.prepare('INSERT INTO Menu_Items (ItemID, Category, Item_Name, Price, Status) VALUES (?, ?, ?, ?, ?)');
                            initialItems.forEach(item => stmt.run(item.ItemID, item.Category, item.Item_Name, item.Price, item.Status));
                            stmt.finalize((err) => {
                                if (err) {
                                    logger.error(`插入初始菜單數據失敗: ${err.message}`);
                                    reject(err);
                                } else {
                                    logger.info('初始菜單數據已創建');
                                }
                            });
                        });
                    } else {
                        logger.info('Menu_Items 數據已存在，跳過插入');
                    }
                });
            }
        });

        // 創建 DineIn_Orders 表
        db.run(`CREATE TABLE IF NOT EXISTS DineIn_Orders (
            OrderID TEXT PRIMARY KEY,
            OrderSequence INTEGER NOT NULL,
            TableNumber TEXT NOT NULL,
            Items TEXT NOT NULL,
            Notes TEXT,
            TotalAmount INTEGER NOT NULL,
            CreatedAt DATETIME NOT NULL,
            Status TEXT NOT NULL
        )`, (err) => {
            if (err) {
                logger.error(`創建 DineIn_Orders 表失敗: ${err.message}`);
                reject(err);
            } else {
                logger.info('DineIn_Orders 表已創建');
            }
        });

        // 創建 Takeaway_Orders 表
        db.run(`CREATE TABLE IF NOT EXISTS Takeaway_Orders (
            OrderID TEXT PRIMARY KEY,
            OrderSequence INTEGER NOT NULL,
            CustomerName TEXT NOT NULL,
            PhoneNumber TEXT NOT NULL,
            Items TEXT NOT NULL,
            Notes TEXT,
            TotalAmount REAL NOT NULL,
            CreatedAt DATETIME NOT NULL,
            Status TEXT NOT NULL,
            PickupTime DATETIME NOT NULL
        )`, (err) => {
            if (err) {
                logger.error(`創建 Takeaway_Orders 表失敗: ${err.message}`);
                reject(err);
            } else {
                logger.info('Takeaway_Orders 表已創建');
            }
        });

        // 創建 CustomerFeedback 表
        db.run(`CREATE TABLE IF NOT EXISTS CustomerFeedback (
            FeedbackID INTEGER PRIMARY KEY AUTOINCREMENT,
            FeedbackText TEXT NOT NULL,
            Time DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => {
            if (err) {
                logger.error(`創建 CustomerFeedback 表失敗: ${err.message}`);
                reject(err);
            } else {
                logger.info('CustomerFeedback 表已創建');
                resolve();
            }
        });
    });
});

// 創建 WebSocket 伺服器
const server = app.listen(port, () => {
    logger.info(`服務器運行在 http://localhost:${port}`);
});
const wss = new WebSocket.Server({ server });

// 管理 WebSocket 客戶端
wss.on('connection', (ws) => {
    logger.info('新的 WebSocket 客戶端已連線');
    ws.on('close', () => {
        logger.info('WebSocket 客戶端已斷線');
    });
    ws.on('error', (error) => {
        logger.error(`WebSocket 錯誤: ${error.message}`);
    });
});

// 創建帳號 API
app.post('/register', (req, res) => {
    const { username, password, confirmPassword, email, phone, fullName } = req.body;

    if (!username || !password || !confirmPassword || !email || !phone || !fullName) {
        logger.warn('註冊失敗: 缺少必要欄位');
        return res.status(400).json({ error: '所有欄位為必填' });
    }
    if (password !== confirmPassword) {
        logger.warn(`註冊失敗: 用戶 ${username} 密碼與確認密碼不一致`);
        return res.status(400).json({ error: '密碼與確認密碼不一致' });
    }

    db.get('SELECT Username FROM Users WHERE Username = ? OR Email = ? OR Phone = ?', [username, email, phone], (err, row) => {
        if (err) {
            logger.error(`檢查唯一性失敗: ${err.message}`);
            return res.status(500).json({ error: '伺服器錯誤' });
        }
        if (row) {
            logger.warn(`註冊失敗: 用戶 ${username} 或 ${email} 或 ${phone} 已存在`);
            return res.status(400).json({ error: '帳號、Email 或電話號碼已存在' });
        }

        const saltRounds = 10;
        bcrypt.hash(password, saltRounds, (err, hash) => {
            if (err) {
                logger.error(`密碼加密失敗: ${err.message}`);
                return res.status(500).json({ error: '伺服器錯誤' });
            }
            db.run(`INSERT INTO Users (Username, Password, Email, Phone, FullName) VALUES (?, ?, ?, ?, ?)`,
                [username, hash, email, phone, fullName], (err) => {
                    if (err) {
                        logger.error(`註冊失敗: ${err.message}`);
                        return res.status(500).json({ error: '註冊失敗' });
                    }
                    logger.info(`用戶 ${username} 註冊成功`);
                    res.json({ message: '註冊成功' });
                });
        });
    });
});

// 忘記密碼 - 發送重置 Token API
app.post('/forgot-password', (req, res) => {
    const { email, phone } = req.body;

    if (!email || !phone) {
        logger.warn('忘記密碼失敗: 缺少 Email 或電話號碼');
        return res.status(400).json({ error: 'Email 和電話號碼為必填' });
    }

    db.get('SELECT UserID, Username FROM Users WHERE Email = ? AND Phone = ?', [email, phone], (err, row) => {
        if (err) {
            logger.error(`查詢用戶失敗: ${err.message}`);
            return res.status(500).json({ error: '伺服器錯誤' });
        }
        if (!row) {
            logger.warn(`忘記密碼失敗: Email ${email} 或電話 ${phone} 不匹配`);
            return res.status(404).json({ error: 'Email 或電話號碼不正確' });
        }

        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetTokenExpiry = new Date(Date.now() + 3600000);

        db.run(
            `UPDATE Users SET ResetToken = ?, ResetTokenExpiry = ? WHERE UserID = ?`,
            [resetToken, resetTokenExpiry, row.UserID],
            (err) => {
                if (err) {
                    logger.error(`更新重置 Token 失敗: ${err.message}`);
                    return res.status(500).json({ error: '伺服器錯誤' });
                }
                logger.info(`為用戶 ${row.Username} 生成重置 Token: ${resetToken}`);
                res.json({ message: '請檢查您的 Email 或電話以獲取重置密碼鏈接', token: resetToken });
            }
        );
    });
});

// 忘記密碼 - 重置密碼 API
app.post('/reset-password', (req, res) => {
    const { token, newPassword, confirmPassword } = req.body;

    if (!token || !newPassword || !confirmPassword) {
        logger.warn('重置密碼失敗: 缺少必要欄位');
        return res.status(400).json({ error: '所有欄位為必填' });
    }
    if (newPassword !== confirmPassword) {
        logger.warn('重置密碼失敗: 新密碼與確認密碼不一致');
        return res.status(400).json({ error: '新密碼與確認密碼不一致' });
    }

    db.get('SELECT UserID FROM Users WHERE ResetToken = ? AND ResetTokenExpiry > ?', [token, new Date()], (err, row) => {
        if (err) {
            logger.error(`查詢 Token 失敗: ${err.message}`);
            return res.status(500).json({ error: '伺服器錯誤' });
        }
        if (!row) {
            logger.warn(`重置密碼失敗: Token ${token} 無效或已過期`);
            return res.status(400).json({ error: '重置 Token 無效或已過期' });
        }

        const saltRounds = 10;
        bcrypt.hash(newPassword, saltRounds, (err, hash) => {
            if (err) {
                logger.error(`密碼加密失敗: ${err.message}`);
                return res.status(500).json({ error: '伺服器錯誤' });
            }
            db.run(
                `UPDATE Users SET Password = ?, ResetToken = NULL, ResetTokenExpiry = NULL WHERE UserID = ?`,
                [hash, row.UserID],
                (err) => {
                    if (err) {
                        logger.error(`重置密碼失敗: ${err.message}`);
                        return res.status(500).json({ error: '伺服器錯誤' });
                    }
                    logger.info(`用戶 ${row.UserID} 密碼已重置`);
                    res.json({ message: '密碼已重置，請使用新密碼登入' });
                }
            );
        });
    });
});

// 登入 API
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get('SELECT * FROM Users WHERE Username = ?', [username], (err, row) => {
        if (err) {
            logger.error(`查詢用戶失敗: ${err.message}`);
            res.status(500).json({ error: '伺服器錯誤' });
            return;
        }
        if (!row) {
            logger.warn(`登入失敗: 用戶 ${username} 不存在`);
            res.status(401).json({ error: '帳號或密碼錯誤' });
            return;
        }
        bcrypt.compare(password, row.Password, (err, isMatch) => {
            if (err) {
                logger.error(`密碼驗證失敗: ${err.message}`);
                res.status(500).json({ error: '伺服器錯誤' });
                return;
            }
            if (isMatch) {
                logger.info(`用戶 ${username} 登入成功`);
                res.json({ message: '登入成功', user: { username: row.Username } });
            } else {
                logger.warn(`登入失敗: 用戶 ${username} 密碼錯誤`);
                res.status(401).json({ error: '帳號或密碼錯誤' });
            }
        });
    });
});

// 登出 API
app.post('/logout', (req, res) => {
    logger.info('用戶執行登出');
    res.json({ message: '登出成功' });
});

// 獲取店家資訊 API（加入緩存與身份驗證）
app.get('/store-info', authenticate, (req, res) => {
    const cacheKey = 'storeSchedule';
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        logger.info('從緩存中獲取店家資訊');
        res.json(cachedData);
    } else {
        db.all('SELECT * FROM Store_Schedule', [], (err, rows) => {
            if (err) {
                logger.error(`獲取店家資訊失敗: ${err.message}`);
                res.status(500).json({ error: err.message });
                return;
            }
            cache.set(cacheKey, rows);
            logger.info('成功獲取店家資訊並緩存');
            res.json(rows);
        });
    }
});

app.post('/store-info/update', authenticate, (req, res) => {
    const { StoreName, Address } = req.body;
    db.run('UPDATE Store_Schedule SET StoreName = ?, Address = ?', [StoreName, Address], function(err) {
        if (err) {
            logger.error(`更新店家資訊失敗: ${err.message}`);
            res.status(500).json({ error: err.message });
            return;
        }
        cache.del('storeSchedule');
        logger.info(`店家資訊已更新，影響 ${this.changes} 行，緩存已清除`);
        res.json({ message: '店家資訊已更新', changes: this.changes });
    });
});

app.post('/store-info/schedule', authenticate, (req, res) => {
    const { Date, MorningStart, MorningEnd, EveningStart, EveningEnd, IsClosedToday } = req.body;
    db.run(
        `UPDATE Store_Schedule SET MorningStart = ?, MorningEnd = ?, EveningStart = ?, EveningEnd = ?, IsClosedToday = ? WHERE Date = ?`,
        [MorningStart, MorningEnd, EveningStart, EveningEnd, IsClosedToday ? 1 : 0, Date],
        function(err) {
            if (err) {
                logger.error(`更新單日營業時間失敗: ${err.message}`);
                res.status(500).json({ error: err.message });
                return;
            }
            cache.del('storeSchedule');
            cache.del(`storeSchedule:${Date}`); // 清除特定日期的緩存
            logger.info(`營業時間已更新，影響 ${this.changes} 行，緩存已清除`);

            // 發送 WebSocket 通知
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'scheduleUpdate', data: { Date } }));
                }
            });

            res.json({ message: '營業時間已更新', changes: this.changes });
        }
    );
});

app.post('/store-info/batch-schedule', authenticate, (req, res) => {
    const { DayOfWeek, Month, IsClosedToday } = req.body;
    const year = new Date().getFullYear();
    const startDate = new Date(`${year}-${Month}-01`);
    const endDate = new Date(startDate);
    endDate.setMonth(startDate.getMonth() + 1);
    endDate.setDate(0);

    const updates = [];
    const updatedDates = []; // 記錄更新的日期
    for (let date = new Date(startDate); date <= endDate; date.setDate(date.getDate() + 1)) {
        const dateStr = date.toISOString().split('T')[0];
        const dayOfWeek = date.toLocaleDateString('zh-TW', { weekday: 'long' });
        if (dayOfWeek === DayOfWeek) {
            updates.push(new Promise((resolve, reject) => {
                db.run(
                    `UPDATE Store_Schedule SET IsClosedToday = ?, MorningStart = ?, MorningEnd = ?, EveningStart = ?, EveningEnd = ? WHERE Date = ?`,
                    [IsClosedToday, IsClosedToday ? null : '11:30', IsClosedToday ? null : '13:30', IsClosedToday ? null : '16:30', IsClosedToday ? null : '20:00', dateStr],
                    function(err) {
                        if (err) {
                            logger.error(`批量更新失敗: ${err.message}`);
                            reject(err);
                        } else {
                            updatedDates.push(dateStr);
                            resolve();
                        }
                    }
                );
            }));
        }
    }

    Promise.all(updates)
        .then(() => {
            cache.del('storeSchedule');
            updatedDates.forEach(date => {
                cache.del(`storeSchedule:${date}`); // 清除每個更新的日期緩存
            });
            logger.info(`批量更新成功: ${DayOfWeek} in ${Month}，緩存已清除`);

            // 發送 WebSocket 通知
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'scheduleUpdate', data: { Dates: updatedDates } }));
                }
            });

            res.json({ message: '批量更新成功' });
        })
        .catch(err => {
            logger.error(`批量更新失敗: ${err.message}`);
            res.status(500).json({ error: err.message });
        });
});

// 獲取菜單 API（公開路由，給消費者使用）
app.get('/api/menu', (req, res) => {
    const cacheKey = 'publicMenuItems';
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        logger.info('從緩存中獲取公開菜單數據');
        res.json(cachedData);
    } else {
        db.all('SELECT * FROM Menu_Items WHERE Status = "供應中"', [], (err, rows) => {
            if (err) {
                logger.error(`獲取公開菜單數據失敗: ${err.message}`);
                res.status(500).json({ error: '資料庫錯誤' });
                return;
            }
            cache.set(cacheKey, rows);
            logger.info('成功獲取公開菜單數據並緩存');
            res.json(rows);
        });
    }
});

// 獲取菜單 API（管理員用，包含所有品項，需身份驗證）
app.get('/menu', authenticate, (req, res) => {
    const cacheKey = 'menuItems';
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        logger.info('從緩存中獲取菜單數據');
        res.json(cachedData);
    } else {
        db.all('SELECT * FROM Menu_Items', [], (err, rows) => {
            if (err) {
                logger.error(`獲取菜單數據失敗: ${err.message}`);
                res.status(500).json({ error: err.message });
                return;
            }
            cache.set(cacheKey, rows);
            logger.info('成功獲取菜單數據並緩存');
            res.json(rows);
        });
    }
});

app.post('/menu/update', authenticate, (req, res) => {
    const { ItemID, Status } = req.body;
    db.run('UPDATE Menu_Items SET Status = ? WHERE ItemID = ?', [Status, ItemID], function(err) {
        if (err) {
            logger.error(`更新菜單狀態失敗: ${err.message}`);
            res.status(500).json({ error: err.message });
            return;
        }
        cache.del('menuItems');
        cache.del('publicMenuItems');
        logger.info(`菜單狀態已更新，影響 ${this.changes} 行，緩存已清除`);
        res.json({ message: '狀態已更新', changes: this.changes });
    });
});

// 新增品項 API（支援圖片上傳）
app.post('/menu/add', authenticate, upload.single('image'), (req, res) => {
    const { Category, Item_Name, Price } = req.body;
    const idRanges = { 'Bento': [101, 199], 'Noodles': [201, 299], 'Side_Dishes': [301, 399], 'Steam_Dishes': [401, 499] };
    const [minID, maxID] = idRanges[Category] || [0, 0];

    db.get(`SELECT MAX(ItemID) as maxID FROM Menu_Items WHERE Category = ?`, [Category], (err, row) => {
        if (err) {
            logger.error(`查詢最大 ItemID 失敗: ${err.message}`);
            return res.status(500).json({ error: err.message });
        }
        let newID = row.maxID ? row.maxID + 1 : minID;
        if (newID > maxID) {
            logger.warn(`新增品項失敗: 該類別 ${Category} 的 ItemID 已達上限`);
            return res.status(400).json({ error: '該類別的 ItemID 已達上限' });
        }

        db.run(`INSERT INTO Menu_Items (ItemID, Category, Item_Name, Price, Status) VALUES (?, ?, ?, ?, ?)`,
            [newID, Category, Item_Name, Price, '供應中'],
            function(err) {
                if (err) {
                    logger.error(`新增品項失敗: ${err.message}`);
                    if (req.file) {
                        fs.unlink(req.file.path, (unlinkErr) => {
                            if (unlinkErr) logger.error(`刪除臨時圖片失敗: ${unlinkErr.message}`);
                        });
                    }
                    return res.status(500).json({ error: err.message });
                }

                if (req.file) {
                    const newImagePath = path.join(uploadDir, `${newID}.jpg`);
                    fs.rename(req.file.path, newImagePath, (renameErr) => {
                        if (renameErr) {
                            logger.error(`重新命名圖片失敗: ${renameErr.message}`);
                        }
                        logger.info(`圖片已重新命名為: ${newID}.jpg`);
                    });
                }

                cache.del('menuItems');
                cache.del('publicMenuItems');
                logger.info(`品項已新增，ItemID: ${newID}，緩存已清除`);
                res.json({ message: '品項已新增', ItemID: newID });
            });
    });
});

// 更新品項 API（支援圖片上傳）
app.put('/menu/update-item', authenticate, upload.single('image'), (req, res) => {
    const { ItemID, Category, Item_Name, Price } = req.body;
    db.run(`UPDATE Menu_Items SET Category = ?, Item_Name = ?, Price = ? WHERE ItemID = ?`,
        [Category, Item_Name, Price, ItemID],
        function(err) {
            if (err) {
                logger.error(`更新品項失敗: ${err.message}`);
                if (req.file) {
                    fs.unlink(req.file.path, (unlinkErr) => {
                        if (unlinkErr) logger.error(`刪除臨時圖片失敗: ${unlinkErr.message}`);
                    });
                }
                return res.status(500).json({ error: err.message });
            }

            if (req.file) {
                const newImagePath = path.join(uploadDir, `${ItemID}.jpg`);
                fs.rename(req.file.path, newImagePath, (renameErr) => {
                    if (renameErr) {
                        logger.error(`重新命名圖片失敗: ${renameErr.message}`);
                    }
                    logger.info(`圖片已更新為: ${ItemID}.jpg`);
                });
            }

            cache.del('menuItems');
            cache.del('publicMenuItems');
            logger.info(`品項已更新，ItemID: ${ItemID}，緩存已清除`);
            res.json({ message: '品項已更新', changes: this.changes });
        });
});

// 刪除品項 API（同時刪除圖片）
app.delete('/menu/delete/:id', authenticate, (req, res) => {
    const ItemID = req.params.id;
    db.run(`DELETE FROM Menu_Items WHERE ItemID = ?`, [ItemID], function(err) {
        if (err) {
            logger.error(`刪除品項失敗: ${err.message}`);
            return res.status(500).json({ error: err.message });
        }

        const imagePath = path.join(uploadDir, `${ItemID}.jpg`);
        fs.unlink(imagePath, (unlinkErr) => {
            if (unlinkErr && unlinkErr.code !== 'ENOENT') {
                logger.error(`刪除圖片失敗: ${unlinkErr.message}`);
            } else {
                logger.info(`圖片已刪除（或不存在）: ${imagePath}`);
            }
        });

        cache.del('menuItems');
        cache.del('publicMenuItems');
        logger.info(`品項已刪除，ItemID: ${ItemID}，緩存已清除`);
        res.json({ message: '品項已刪除', changes: this.changes });
    });
});

// 查詢當日最大 OrderSequence API（內用）
app.get('/api/dinein-orders/max-sequence', (req, res) => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const datePrefix = `10${year}${month}${day}`;

    db.get(
        `SELECT MAX(OrderSequence) as maxSequence FROM DineIn_Orders WHERE OrderID LIKE ?`,
        [`${datePrefix}%`],
        (err, row) => {
            if (err) {
                logger.error(`查詢最大 OrderSequence 失敗: ${err.message}`);
                res.status(500).json({ error: err.message });
                return;
            }
            const maxSequence = row.maxSequence || 0;
            res.json({ maxSequence });
        }
    );
});

// 提交內用訂單 API（公開路由，給消費者使用）
app.post('/api/dinein-orders', (req, res) => {
    logger.info('收到 /api/dinein-orders 請求', req.body);
    const {
        OrderID,
        OrderSequence,
        TableNumber,
        Items,
        Notes = '',
        TotalAmount,
        CreatedAt,
        Status = ''
    } = req.body;

    let itemsJson;
    try {
        itemsJson = JSON.stringify(Items);
    } catch (e) {
        logger.warn('Items 序列化失敗');
        return res.status(400).json({ error: 'Items 序列化失敗' });
    }

    if (!OrderID || OrderSequence == null || !TableNumber || !Items || TotalAmount == null || !CreatedAt) {
        logger.warn('提交訂單失敗: 缺少必要欄位');
        return res.status(400).json({ error: '缺少必要欄位' });
    }

    const sql = `
        INSERT INTO DineIn_Orders
        (OrderID, OrderSequence, TableNumber, Items, Notes, TotalAmount, CreatedAt, Status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

    db.run(sql,
        [OrderID, OrderSequence, TableNumber, itemsJson, Notes, TotalAmount, CreatedAt, Status],
        function(err) {
            if (err) {
                logger.error(`訂單寫入失敗: ${err.message}`);
                return res.status(500).json({ error: err.message });
            }
            cache.del('dineInOrders');
            logger.info(`訂單寫入成功，lastID: ${this.lastID}，內用訂單緩存已清除`);

            const newOrder = {
                OrderID,
                OrderSequence,
                TableNumber,
                Items: itemsJson,
                Notes,
                TotalAmount,
                CreatedAt,
                Status,
                type: 'dinein'
            };
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'newOrder', data: newOrder }));
                }
            });

            res.status(201).json({ success: true, lastID: this.lastID });
        }
    );
});

// 查詢內用訂單 API（需身份驗證，給管理員使用）
app.get('/api/dinein-orders', authenticate, (req, res) => {
    const cacheKey = 'dineInOrders';
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        logger.info('從緩存中獲取內用訂單數據');
        res.json(cachedData);
    } else {
        db.all('SELECT * FROM DineIn_Orders', [], (err, rows) => {
            if (err) {
                logger.error(`獲取內用訂單數據失敗: ${err.message}`);
                res.status(500).json({ error: err.message });
                return;
            }
            cache.set(cacheKey, rows);
            logger.info('成功獲取內用訂單數據並緩存');
            res.json(rows);
        });
    }
});

// 查詢單一內用訂單 API
app.get('/api/dinein-orders/:orderId', (req, res) => {
    const { orderId } = req.params;
    const cacheKey = `dineInOrder:${orderId}`;
    const cachedData = cache.get(cacheKey);

    if (cachedData) {
        logger.info(`從緩存中獲取內用訂單: OrderID=${orderId}`);
        return res.json(cachedData);
    }

    logger.info(`查詢內用訂單: OrderID=${orderId}`);
    db.get('SELECT * FROM DineIn_Orders WHERE OrderID = ?', [orderId], (err, row) => {
        if (err) {
            logger.error(`查詢內用訂單失敗: ${err.message}`);
            return res.status(500).json({ error: '伺服器錯誤' });
        }
        if (!row) {
            logger.warn(`內用訂單未找到: OrderID=${orderId}`);
            return res.status(404).json({ error: '訂單未找到' });
        }
        cache.set(cacheKey, row);
        logger.info(`成功查詢內用訂單並緩存: OrderID=${orderId}`);
        res.json(row);
    });
});

// 完成內用訂單 API
app.put('/api/dinein-orders/complete', authenticate, (req, res) => {
    const { OrderID, OrderSequence, Status } = req.body;
    if (!OrderID || OrderSequence == null || !Status) {
        logger.warn('更新內用訂單失敗: 缺少必要欄位');
        return res.status(400).json({ error: '缺少必要欄位' });
    }

    db.run(
        `UPDATE DineIn_Orders SET Status = ? WHERE OrderID = ? AND OrderSequence = ?`,
        [Status, OrderID, OrderSequence],
        function(err) {
            if (err) {
                logger.error(`更新內用訂單狀態失敗: ${err.message}`);
                return res.status(500).json({ error: err.message });
            }
            if (this.changes === 0) {
                logger.warn(`內用訂單 ${OrderID}-${OrderSequence} 未找到`);
                return res.status(404).json({ error: '訂單未找到' });
            }
            cache.del('dineInOrders');
            cache.del(`dineInOrder:${OrderID}`);
            logger.info(`內用訂單 ${OrderID}-${OrderSequence} 狀態更新為 ${Status}，內用訂單緩存已清除`);

            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'orderUpdate', data: { OrderID, OrderSequence, Status } }));
                }
            });

            res.json({ message: '訂單狀態已更新', changes: this.changes });
        }
    );
});

// 刪除內用訂單 API
app.delete('/api/dinein-orders/:orderId/:orderSequence', authenticate, (req, res) => {
    const { orderId, orderSequence } = req.params;
    db.run(
        `DELETE FROM DineIn_Orders WHERE OrderID = ? AND OrderSequence = ?`,
        [orderId, orderSequence],
        function(err) {
            if (err) {
                logger.error(`刪除內用訂單失敗: ${err.message}`);
                return res.status(500).json({ error: err.message });
            }
            if (this.changes === 0) {
                logger.warn(`內用訂單 ${orderId}-${orderSequence} 未找到`);
                return res.status(404).json({ error: '訂單未找到' });
            }
            cache.del('dineInOrders');
            cache.del(`dineInOrder:${orderId}`);
            logger.info(`內用訂單 ${orderId}-${orderSequence} 已刪除，內用訂單緩存已清除`);

            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'orderDelete', data: { OrderID: orderId, OrderSequence: orderSequence } }));
                }
            });

            res.json({ message: '訂單已刪除', changes: this.changes });
        }
    );
});

// 查詢當日最大 OrderSequence API（外帶）
app.get('/api/takeaway-orders/max-sequence', (req, res) => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const datePrefix = `20${year}${month}${day}`;

    db.get(
        `SELECT MAX(OrderSequence) as maxSequence FROM Takeaway_Orders WHERE OrderID LIKE ?`,
        [`${datePrefix}%`],
        (err, row) => {
            if (err) {
                logger.error(`查詢最大 OrderSequence (外帶) 失敗: ${err.message}`);
                res.status(500).json({ error: err.message });
                return;
            }
            const maxSequence = row.maxSequence || 0;
            res.json({ maxSequence });
        }
    );
});

// 提交外帶訂單 API（公開路由，給消費者使用）
app.post('/api/takeaway-orders', (req, res) => {
    logger.info('收到 /api/takeaway-orders 請求', req.body);
    const {
        OrderID,
        OrderSequence,
        CustomerName,
        PhoneNumber,
        Items,
        Notes = '',
        TotalAmount,
        CreatedAt,
        Status = '',
        PickupTime
    } = req.body;

    let itemsJson;
    try {
        itemsJson = JSON.stringify(Items);
    } catch (e) {
        logger.warn('Items 序列化失敗');
        return res.status(400).json({ error: 'Items 序列化失敗' });
    }

    if (!OrderID || OrderSequence == null || !CustomerName || !PhoneNumber || !Items || TotalAmount == null || !CreatedAt || !PickupTime) {
        logger.warn('提交外帶訂單失敗: 缺少必要欄位');
        return res.status(400).json({ error: '缺少必要欄位' });
    }

    const sql = `
        INSERT INTO Takeaway_Orders
        (OrderID, OrderSequence, CustomerName, PhoneNumber, Items, Notes, TotalAmount, CreatedAt, Status, PickupTime)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    db.run(sql,
        [OrderID, OrderSequence, CustomerName, PhoneNumber, itemsJson, Notes, TotalAmount, CreatedAt, Status, PickupTime],
        function(err) {
            if (err) {
                logger.error(`外帶訂單寫入失敗: ${err.message}`);
                return res.status(500).json({ error: err.message });
            }
            cache.del('takeawayOrders');
            logger.info(`外帶訂單寫入成功，lastID: ${this.lastID}，外帶訂單緩存已清除`);

            const newOrder = {
                OrderID,
                OrderSequence,
                CustomerName,
                PhoneNumber,
                Items: itemsJson,
                Notes,
                TotalAmount,
                CreatedAt,
                Status,
                PickupTime,
                type: 'takeaway'
            };
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'newOrder', data: newOrder }));
                }
            });

            res.status(201).json({ success: true, lastID: this.lastID, status: Status });
        }
    );
});

// 查詢外帶訂單 API（需身份驗證，給管理員使用）
app.get('/api/takeaway-orders', authenticate, (req, res) => {
    const cacheKey = 'takeawayOrders';
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        logger.info('從緩存中獲取外帶訂單數據');
        res.json(cachedData);
    } else {
        db.all('SELECT * FROM Takeaway_Orders', [], (err, rows) => {
            if (err) {
                logger.error(`獲取外帶訂單數據失敗: ${err.message}`);
                res.status(500).json({ error: err.message });
                return;
            }
            cache.set(cacheKey, rows);
            logger.info('成功獲取外帶訂單數據並緩存');
            res.json(rows);
        });
    }
});

// 查詢單一外帶訂單 API
app.get('/api/takeaway-orders/:orderId', (req, res) => {
    const { orderId } = req.params;
    const cacheKey = `takeawayOrder:${orderId}`;
    const cachedData = cache.get(cacheKey);

    if (cachedData) {
        logger.info(`從緩存中獲取外帶訂單: OrderID=${orderId}`);
        return res.json(cachedData);
    }

    logger.info(`查詢外帶訂單: OrderID=${orderId}`);
    db.get('SELECT * FROM Takeaway_Orders WHERE OrderID = ?', [orderId], (err, row) => {
        if (err) {
            logger.error(`查詢外帶訂單失敗: ${err.message}`);
            return res.status(500).json({ error: '伺服器錯誤' });
        }
        if (!row) {
            logger.warn(`外帶訂單未找到: OrderID=${orderId}`);
            return res.status(404).json({ error: '外帶訂單未找到' });
        }
        try {
            row.Items = JSON.parse(row.Items);
        } catch (e) {
            logger.error(`解析外帶訂單項目失敗: ${e.message}`);
            row.Items = [];
        }
        cache.set(cacheKey, row);
        logger.info(`成功查詢外帶訂單並緩存: OrderID=${orderId}`);
        res.json(row);
    });
});

// 完成外帶訂單 API
app.put('/api/takeaway-orders/complete', authenticate, (req, res) => {
    const { OrderID, OrderSequence, Status } = req.body;
    if (!OrderID || OrderSequence == null || !Status) {
        logger.warn('更新外帶訂單失敗: 缺少必要欄位');
        return res.status(400).json({ error: '缺少必要欄位' });
    }

    db.run(
        `UPDATE Takeaway_Orders SET Status = ? WHERE OrderID = ? AND OrderSequence = ?`,
        [Status, OrderID, OrderSequence],
        function(err) {
            if (err) {
                logger.error(`更新外帶訂單狀態失敗: ${err.message}`);
                return res.status(500).json({ error: err.message });
            }
            if (this.changes === 0) {
                logger.warn(`外帶訂單 ${OrderID}-${OrderSequence} 未找到`);
                return res.status(404).json({ error: '訂單未找到' });
            }
            cache.del('takeawayOrders'); // 確保清除整體外帶訂單緩存
            cache.del(`takeawayOrder:${OrderID}`);
            logger.info(`外帶訂單 ${OrderID}-${OrderSequence} 狀態更新為 ${Status}，外帶訂單緩存已清除`);

            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'orderUpdate', data: { OrderID, OrderSequence, Status } }));
                }
            });

            res.json({ message: '訂單狀態已更新', changes: this.changes });
        }
    );
});

// 刪除外帶訂單 API
app.delete('/api/takeaway-orders/:orderId/:orderSequence', authenticate, (req, res) => {
    const { orderId, orderSequence } = req.params;
    db.run(
        `DELETE FROM Takeaway_Orders WHERE OrderID = ? AND OrderSequence = ?`,
        [orderId, orderSequence],
        function(err) {
            if (err) {
                logger.error(`刪除外帶訂單失敗: ${err.message}`);
                return res.status(500).json({ error: err.message });
            }
            if (this.changes === 0) {
                logger.warn(`外帶訂單 ${orderId}-${orderSequence} 未找到`);
                return res.status(404).json({ error: '訂單未找到' });
            }
            cache.del('takeawayOrders'); // 確保清除整體外帶訂單緩存
            cache.del(`takeawayOrder:${orderId}`);
            logger.info(`外帶訂單 ${orderId}-${orderSequence} 已刪除，外帶訂單緩存已清除`);

            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'orderDelete', data: { OrderID: orderId, OrderSequence: orderSequence } }));
                }
            });

            res.json({ message: '訂單已取消', changes: this.changes });
        }
    );
});

// 刪除回饋 API（需身份驗證，給管理員使用）
app.delete('/api/feedback/delete', authenticate, (req, res) => {
    const { ID } = req.body;
    if (!ID) {
        logger.warn('刪除回饋失敗: 缺少 ID');
        return res.status(400).json({ error: '缺少回饋 ID' });
    }

    db.run('DELETE FROM CustomerFeedback WHERE ID = ?', [ID], function(err) {
        if (err) {
            logger.error(`刪除回饋失敗: ${err.message}`);
            return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
            logger.warn(`回饋 ID ${ID} 未找到`);
            return res.status(404).json({ error: '回饋未找到' });
        }
        cache.del('customerFeedback');
        logger.info(`回饋 ID ${ID} 已刪除，緩存已清除`);
        res.json({ message: '回饋已刪除', changes: this.changes });
    });
});

// 新增意見回饋 API
app.post('/api/feedback2', (req, res) => {
    console.log("收到 /api/feedback2 請求，body=", req.body);

    const { FeedbackText } = req.body;

    if (!FeedbackText) {
        return res.status(400).json({ error: '意見內容不可為空' });
    }

    const sql = `INSERT INTO CustomerFeedback (FeedbackText, Time) VALUES (?, DATETIME('now'))`;

    db.run(sql, [FeedbackText], function (err) {
        if (err) {
            console.error(`❌ 插入意見回饋失敗: ${err.message}`);
            return res.status(500).json({ error: err.message });
        }
        console.log('✅ 意見回饋已寫入，ID=', this.lastID);
        cache.del('customerFeedback');
        logger.info(`意見回饋已寫入，ID: ${this.lastID}，緩存已清除`);
        res.status(201).json({ message: '感謝您的回饋！', feedbackID: this.lastID });
    });
});

// 獲取顧客回饋 API（需身份驗證，給管理員使用）
app.get('/api/feedback', authenticate, (req, res) => {
    const cacheKey = 'customerFeedback';
    const cachedData = cache.get(cacheKey);
    if (cachedData) {
        logger.info('從緩存中獲取顧客回饋數據');
        res.json(cachedData);
    } else {
        db.all('SELECT * FROM CustomerFeedback', [], (err, rows) => {
            if (err) {
                logger.error(`獲取顧客回饋數據失敗: ${err.message}`);
                res.status(500).json({ error: err.message });
                return;
            }
            cache.set(cacheKey, rows);
            logger.info('成功獲取顧客回饋數據並緩存');
            res.json(rows);
        });
    }
});

// 獲取當日營業時間 API（公開路由，給消費者使用）
app.get('/api/store-schedule', (req, res) => {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const cacheKey = `storeSchedule:${date}`;
    const cachedData = cache.get(cacheKey);

    if (cachedData) {
        logger.info(`從緩存中獲取當日營業時間: ${date}`);
        res.json(cachedData);
    } else {
        db.get('SELECT * FROM Store_Schedule WHERE Date = ?', [date], (err, row) => {
            if (err) {
                logger.error(`獲取當日營業時間失敗: ${err.message}`);
                res.status(500).json({ error: '資料庫錯誤' });
                return;
            }
            if (!row) {
                logger.warn(`無當日營業時間數據: ${date}`);
                res.status(404).json({ error: '無當日營業時間數據' });
                return;
            }
            cache.set(cacheKey, row);
            logger.info(`成功獲取當日營業時間並緩存: ${date}`);
            res.json(row);
        });
    }
});

// 關閉資料庫
process.on('SIGINT', () => {
    db.close((err) => {
        if (err) {
            logger.error(`關閉資料庫失敗: ${err.message}`);
        }
        logger.info('資料庫已關閉，服務器正在關閉');
        process.exit(0);
    });
});

// 啟動服務器
dbInit.then(() => {
    logger.info('資料庫初始化完成');
}).catch(err => {
    logger.error(`資料庫初始化失敗: ${err.message}`);
    process.exit(1);
});