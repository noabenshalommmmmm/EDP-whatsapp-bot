/**
 * שרת Webhook בסיסי לחיבור WhatsApp Cloud API (Meta).
 * תפקידו:
 *  1. לענות על בקשת האימות (GET) ששולח Meta בעת "Verify and Save".
 *  2. לקבל הודעות/עדכוני סטטוס נכנסים (POST) ולהדפיס אותם ללוג.
 *
 * הרצה מקומית:   npm install && npm start
 * פריסה בענן:    ראו README.md (הוראות ל-Render)
 */

const express = require("express");
const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "CHANGE_ME";

// --- בריאות השרת (שימושי לבדיקה מהירה שהשרת חי) ---
app.get("/", (req, res) => {
  res.send("WhatsApp webhook server is running.");
});

// --- שלב האימות של Meta (Callback URL verification) ---
// Meta שולח GET עם הפרמטרים: hub.mode, hub.verify_token, hub.challenge
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified successfully.");
    return res.status(200).send(challenge);
  }

  console.warn("Webhook verification failed. Token mismatch or bad mode.");
  return res.sendStatus(403);
});

// --- קבלת הודעות/אירועים נכנסים מ-WhatsApp ---
app.post("/webhook", (req, res) => {
  const body = req.body;

  if (body.object) {
    console.log("Incoming WhatsApp event:", JSON.stringify(body, null, 2));

    // כאן ניתן בהמשך להוסיף לוגיקה: שמירה ל-DB, מענה אוטומטי, שליחת הודעה חזרה וכו'.

    return res.sendStatus(200);
  }

  return res.sendStatus(404);
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
