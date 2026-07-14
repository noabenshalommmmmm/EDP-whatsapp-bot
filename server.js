/**
 * שרת Webhook ל-WhatsApp Cloud API (Meta) — בוט "כניסה / יציאה" לדיווח שעות עבודה.
 *
 * תהליך:
 *  1. עובד שולח "כניסה" או "יציאה" (עם שעה אופציונלית, למשל "כניסה 08:30").
 *  2. הבוט מזהה את המשתמש מול טבלת EDP_MOBILEUSERSDATA (oldwire) לפי מספר הטלפון.
 *  3. הבוט יוצר שורה חדשה במסך WORKHOURS בפריורטי עם USERLOGIN, WDATE, ו-FROMTIMEA/TOTIME.
 *  4. הבוט מחזיר הודעת אישור או שגיאה למשתמש.
 *
 * הרצה מקומית:   npm install && npm start
 * פריסה בענן:    ראו README.md (הוראות ל-Render)
 */

const express = require("express");
const app = express();

app.use(express.json());

// --- הגדרות כלליות (Webhook) ---
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "CHANGE_ME";

// --- הגדרות WhatsApp Cloud API (לשליחת תשובות) ---
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v20.0";

// --- הגדרות זיהוי משתמש (oldwire / EDP_MOBILEUSERSDATA) ---
const OLDWIRE_BASE_URL =
  process.env.OLDWIRE_BASE_URL ||
  "https://oldwire.edpcloud.co.il/odata/Priority/tabula.ini/appapi";
const OLDWIRE_USER = process.env.OLDWIRE_USER || "";
const OLDWIRE_PASS = process.env.OLDWIRE_PASS || "";

// --- הגדרות פריורטי (WORKHOURS) ---
const PRIORITY_WORKHOURS_URL =
  process.env.PRIORITY_WORKHOURS_URL ||
  "https://edpdemov20.edpcloud.co.il/odata/Priority/tabula.ini/t250626/WORKHOURS";
const PRIORITY_USER = process.env.PRIORITY_USER || "";
const PRIORITY_PASS = process.env.PRIORITY_PASS || "";

function basicAuthHeader(user, pass) {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

// ============================================================
// עזרי תאריך/שעה (אזור זמן ישראל)
// ============================================================
// מחזיר את הפרשי השעות הנוכחי של ישראל מ-UTC בפורמט "+03:00" / "+02:00"
// (משתנה לפי שעון קיץ/חורף, ולכן מחושב דינמית ולא קבוע בקוד)
function getIsraelUtcOffset(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    timeZoneName: "shortOffset",
  }).formatToParts(date);

  const tzPart = parts.find((p) => p.type === "timeZoneName")?.value || "GMT+2";
  const match = tzPart.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return "+00:00";

  const sign = match[1];
  const hh = match[2].padStart(2, "0");
  const mm = match[3] || "00";
  return `${sign}${hh}:${mm}`;
}

function nowInIsrael() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const map = {};
  parts.forEach((p) => (map[p.type] = p.value));

  return {
    date: `${map.year}-${map.month}-${map.day}`, // YYYY-MM-DD
    time: `${map.hour}:${map.minute}`, // HH:MM
    utcOffset: getIsraelUtcOffset(now), // "+03:00" / "+02:00"
  };
}

// ============================================================
// זיהוי פקודה: "כניסה" / "יציאה" עם שעה אופציונלית ("כניסה 08:30")
// ============================================================
function parseCommand(text) {
  if (!text) return null;
  const trimmed = text.trim();
  const match = trimmed.match(/^(כניסה|יציאה)(?:\s+(\d{1,2}:\d{2}))?\s*$/);
  if (!match) return null;

  const action = match[1] === "כניסה" ? "checkin" : "checkout";
  const overrideTime = match[2] || null;
  return { action, overrideTime };
}

// המרת מספר טלפון בפורמט WhatsApp (972525603361) לפורמט מקומי (0525603361)
function toLocalIsraeliNumber(waNumber) {
  if (waNumber.startsWith("972")) {
    return "0" + waNumber.slice(3);
  }
  return waNumber;
}

// ============================================================
// שלב 2: זיהוי המשתמש מול EDP_MOBILEUSERSDATA (oldwire)
// ============================================================
async function findUserByPhone(localPhone) {
  const url = `${OLDWIRE_BASE_URL}/EDP_MOBILEUSERSDATA?$filter=PHONENUMBER eq '${localPhone}'`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: basicAuthHeader(OLDWIRE_USER, OLDWIRE_PASS),
      Accept: "application/json",
    },
  });

  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`תשובה לא תקינה משרת הזיהוי (${response.status}): ${raw.slice(0, 300)}`);
  }

  if (!response.ok) {
    const msg = data?.error?.message?.value || data?.error?.message || raw;
    throw new Error(`שגיאה בזיהוי המשתמש: ${msg}`);
  }

  const records = data.value || [];
  if (records.length === 0) return null;

  return records[0]; // כולל השדות USERNAME, INACTIVE
}

// בדיקה האם המשתמש מסומן כ"לא פעיל" (השדה INACTIVE)
// שים לב: ייתכן שיהיה צורך להתאים את הבדיקה לפי הפורמט המדויק שמחזירה פריורטי (boolean / "Y" / 1 וכו')
function isUserInactive(user) {
  const v = user.INACTIVE;
  return v === true || v === "Y" || v === "y" || v === 1 || v === "1";
}

// ============================================================
// שלב 3: יצירת שורה ב-WORKHOURS (פריורטי)
// ============================================================
async function createWorkHoursRow({ userLogin, date, action, time, utcOffset }) {
  const payload = {
    USERLOGIN: userLogin,
    WDATE: `${date}T00:00:00${utcOffset}`,
  };

  if (action === "checkin") {
    payload.FROMTIMEA = time;
  } else {
    payload.TOTIME = time;
  }

  const response = await fetch(PRIORITY_WORKHOURS_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(PRIORITY_USER, PRIORITY_PASS),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  const raw = await response.text();

  if (!response.ok) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new Error(`שגיאה בעדכון פריורטי (${response.status}): ${raw.slice(0, 300)}`);
    }
    const msg = data?.error?.message?.value || data?.error?.message || raw;
    throw new Error(`שגיאה בעדכון פריורטי: ${msg}`);
  }

  return true;
}

// ============================================================
// שליחת תשובה ל-WhatsApp
// ============================================================
async function sendWhatsAppReply(to, text) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.warn("WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID לא מוגדרים - לא ניתן לשלוח תשובה.");
    return;
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("שגיאה בשליחת הודעת WhatsApp:", errText);
  }
}

// ============================================================
// הלוגיקה המרכזית: טיפול בהודעת "כניסה"/"יציאה"
// ============================================================
async function handleAttendanceMessage(fromWaNumber, text) {
  const command = parseCommand(text);

  if (!command) {
    await sendWhatsAppReply(
      fromWaNumber,
      "לא הבנתי את ההודעה. שלחו 'כניסה' או 'יציאה' (אפשר גם עם שעה, למשל 'כניסה 08:30')."
    );
    return;
  }

  const localPhone = toLocalIsraeliNumber(fromWaNumber);
  const { date, time: nowTime, utcOffset } = nowInIsrael();
  const time = command.overrideTime || nowTime;

  try {
    const user = await findUserByPhone(localPhone);

    if (!user) {
      await sendWhatsAppReply(
        fromWaNumber,
        "מספר הטלפון שלך לא נמצא במערכת. יש לפנות למנהל המערכת."
      );
      return;
    }

    if (isUserInactive(user)) {
      await sendWhatsAppReply(
        fromWaNumber,
        "המשתמש שלך אינו פעיל במערכת. יש לפנות למנהל המערכת."
      );
      return;
    }

    await createWorkHoursRow({
      userLogin: user.USERNAME,
      date,
      action: command.action,
      time,
      utcOffset,
    });

    const successText = command.action === "checkin" ? "עודכן כניסה" : "עודכן יציאה";
    await sendWhatsAppReply(fromWaNumber, successText);
  } catch (err) {
    console.error("שגיאה בטיפול בהודעת נוכחות:", err);
    await sendWhatsAppReply(fromWaNumber, `אירעה שגיאה: ${err.message}`);
  }
}

// ============================================================
// נתיבי Express
// ============================================================
app.get("/", (req, res) => {
  res.send("WhatsApp attendance bot is running.");
});

// מדיניות פרטיות (נדרשת ע"י Meta כדי לעבור למצב Live)
app.get("/privacy", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <title>מדיניות פרטיות - בוט דיווח שעות עבודה | EDP Group</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #222; }
    h1 { font-size: 22px; }
    h2 { font-size: 18px; margin-top: 30px; }
  </style>
</head>
<body>
  <h1>מדיניות פרטיות - בוט דיווח שעות עבודה</h1>
  <p>עודכן לאחרונה: ${new Date().toLocaleDateString("he-IL")}</p>

  <p>
    שירות זה ("הבוט") הינו כלי פנימי של EDP Group המאפשר לעובדים לדווח שעות כניסה ויציאה
    באמצעות הודעות WhatsApp, לצורך עדכון אוטומטי של מערכת ניהול שעות העבודה (Priority).
  </p>

  <h2>אילו נתונים נאספים</h2>
  <p>
    הבוט מעבד את מספר הטלפון של השולח, את תוכן ההודעה (למשל "כניסה" / "יציאה" ושעה),
    ואת חותמת הזמן של ההודעה. נתונים אלו משמשים אך ורק לצורך זיהוי העובד ועדכון שעות
    העבודה שלו במערכת הארגונית הפנימית.
  </p>

  <h2>כיצד נעשה שימוש בנתונים</h2>
  <p>
    הנתונים משמשים לזיהוי העובד מול מערכת הארגון, ולעדכון רישום שעות עבודה במערכת
    Priority של החברה. הנתונים אינם נמכרים, משותפים או מועברים לגורמי צד שלישי מחוץ
    למערכות הארגוניות הפנימיות של EDP Group.
  </p>

  <h2>שמירת נתונים</h2>
  <p>
    נתוני ההודעות אינם נשמרים על ידי הבוט מעבר לזמן הנדרש לביצוע העדכון במערכת. רישום
    שעות העבודה עצמו נשמר במערכת הפנימית (Priority) בהתאם למדיניות שמירת הנתונים של החברה.
  </p>

  <h2>יצירת קשר</h2>
  <p>
    לשאלות בנוגע למדיניות פרטיות זו, ניתן לפנות לצוות ה-IT של EDP Group.
  </p>
</body>
</html>`);
});

// אימות ה-Webhook מול Meta
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

// קבלת הודעות נכנסות
app.post("/webhook", (req, res) => {
  const body = req.body;

  // עונים ל-Meta מיד (חובה תוך זמן קצר), והטיפול בפועל ממשיך ברקע
  res.sendStatus(200);

  if (!body.object) return;

  try {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (message && message.type === "text") {
      const fromWaNumber = message.from; // בפורמט בינלאומי, למשל 972525603361
      const text = message.text?.body || "";
      console.log(`הודעה נכנסת מ-${fromWaNumber}: ${text}`);
      handleAttendanceMessage(fromWaNumber, text);
    } else {
      console.log("Incoming WhatsApp event (not a text message):", JSON.stringify(body, null, 2));
    }
  } catch (err) {
    console.error("שגיאה בעיבוד ההודעה הנכנסת:", err);
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
