import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import nodemailer from "nodemailer";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Multer configuration for logo uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, "logo-" + uniqueSuffix + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

const db = new Database("volunteer.db");

// Initialize Database
db.exec(`
  CREATE TABLE IF NOT EXISTS check_ins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    group_name TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Initialize default settings
const settingsCount = db.prepare("SELECT COUNT(*) as count FROM settings").get() as { count: number };
if (settingsCount.count === 0) {
  const insertSetting = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
  insertSetting.run("app_title", "CPI Check in");
  insertSetting.run("encouraging_verse", "Let us not become weary in doing good, for at the proper time we will reap a harvest if we do not give up.");
  insertSetting.run("verse_reference", "Galatians 6:9");
  insertSetting.run("bg_url", "https://images.unsplash.com/photo-1593113598332-cd288d649433?auto=format&fit=crop&q=80&w=2000");
  insertSetting.run("primary_color", "#4f46e5");
  insertSetting.run("logo_url", "");
  insertSetting.run("thank_you_message", "Thank you for being here!");
  insertSetting.run("thank_you_verse", "Each of you should use whatever gift you have received to serve others.");
  insertSetting.run("thank_you_reference", "1 Peter 4:10");
}

async function startServer() {
  const app = express();
  app.use(express.json());
  app.use("/uploads", express.static(uploadsDir));
  const PORT = 3000;

  // API Routes
  app.post("/api/upload-logo", upload.single("logo"), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    const logoUrl = `/uploads/${req.file.filename}`;
    // Update settings in DB
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("logo_url", logoUrl);
    res.json({ logo_url: logoUrl });
  });

  app.post("/api/email-export", async (req, res) => {
    const { email, date, group } = req.body;
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    try {
      // Get data for export
      let query = "SELECT * FROM check_ins";
      const params: any[] = [];
      const conditions: string[] = [];

      if (date) {
        conditions.push("DATE(timestamp) = DATE(?)");
        params.push(date);
      }
      if (group) {
        conditions.push("group_name = ?");
        params.push(group);
      }

      if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ");
      }
      query += " ORDER BY timestamp DESC";

      const checkIns = db.prepare(query).all(...params) as any[];
      
      // Generate CSV
      const headers = ["ID", "Name", "Group", "Date", "Time"];
      const rows = checkIns.map(ci => {
        const d = new Date(ci.timestamp);
        return [
          ci.id,
          `"${ci.name.replace(/"/g, '""')}"`,
          `"${ci.group_name.replace(/"/g, '""')}"`,
          d.toLocaleDateString(),
          d.toLocaleTimeString()
        ].join(",");
      });

      const csvContent = [headers.join(","), ...rows].join("\n");
      const filename = `cpi_checkins_${date || 'all'}.csv`;

      // Email configuration
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || "587"),
        secure: process.env.SMTP_SECURE === "true",
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      await transporter.sendMail({
        from: `"CPI Check-in System" <${process.env.SMTP_USER}>`,
        to: email,
        subject: `CPI Check-in Export - ${new Date().toLocaleDateString()}`,
        text: `Please find the attached check-in data for ${date || 'all dates'}${group ? ` and group ${group}` : ''}.`,
        attachments: [
          {
            filename: filename,
            content: csvContent,
          },
        ],
      });

      res.json({ success: true });
    } catch (error: any) {
      console.error("Email error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/settings", (req, res) => {
    const settings = db.prepare("SELECT * FROM settings").all() as { key: string, value: string }[];
    const settingsObj = settings.reduce((acc, curr) => ({ ...acc, [curr.key]: curr.value }), {});
    res.json(settingsObj);
  });

  app.post("/api/settings", (req, res) => {
    const settings = req.body;
    try {
      const updateSetting = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
      const transaction = db.transaction((data) => {
        for (const [key, value] of Object.entries(data)) {
          updateSetting.run(key, value);
        }
      });
      transaction(settings);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/check-ins", (req, res) => {
    const checkIns = db.prepare("SELECT * FROM check_ins ORDER BY timestamp DESC").all();
    res.json(checkIns);
  });

  app.post("/api/check-in", (req, res) => {
    const { name, group_name } = req.body;
    if (!name || !group_name) {
      return res.status(400).json({ error: "Name and group are required" });
    }
    try {
      db.prepare("INSERT INTO check_ins (name, group_name) VALUES (?, ?)").run(name, group_name);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/export", (req, res) => {
    const { date, group } = req.query;
    try {
      let query = "SELECT * FROM check_ins";
      const params: any[] = [];
      const conditions: string[] = [];

      if (date) {
        conditions.push("DATE(timestamp) = DATE(?)");
        params.push(date);
      }
      if (group) {
        conditions.push("group_name = ?");
        params.push(group);
      }

      if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ");
      }
      query += " ORDER BY timestamp DESC";

      const checkIns = db.prepare(query).all(...params) as any[];
      
      // Generate CSV
      const headers = ["ID", "Name", "Group", "Date", "Time"];
      const rows = checkIns.map(ci => {
        const d = new Date(ci.timestamp);
        return [
          ci.id,
          `"${ci.name.replace(/"/g, '""')}"`,
          `"${ci.group_name.replace(/"/g, '""')}"`,
          d.toLocaleDateString(),
          d.toLocaleTimeString()
        ].join(",");
      });

      const csvContent = [headers.join(","), ...rows].join("\n");
      
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename=cpi_checkins_${date || 'all'}.csv`);
      res.status(200).send(csvContent);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
