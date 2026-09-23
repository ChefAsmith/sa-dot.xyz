require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Ensure data directory exists
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR);
}

function getFilePath(tableName) {
  return path.join(DATA_DIR, `${tableName}.json`);
}

const ALL_SUBDIVISIONS = [
  "Highway Incident Management & Patrol",
  "Towing & Recovery",
  "Maintenance & Infrastructure",
  "Traffic Control & Flagging",
  "Heavy Machinery & Logistics"
];

// -----------------------------------------------------------------------------
// AES-256-GCM Encryption Helper
// -----------------------------------------------------------------------------
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
  ? Buffer.from(process.env.ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32))
  : crypto.scryptSync('sadot-default-internal-salt', 'salt', 32);

function encrypt(text) {
  if (!text) return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(String(text), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

function decrypt(cipherText) {
  if (!cipherText || typeof cipherText !== 'string' || !cipherText.includes(':')) return cipherText;
  try {
    const [ivHex, tagHex, encrypted] = cipherText.split(':');
    if (!ivHex || !tagHex || !encrypted) return cipherText;
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return cipherText;
  }
}

// -----------------------------------------------------------------------------
// Discord Webhook Helper (settings.json has FIRST priority over .env)
// -----------------------------------------------------------------------------
function getWebhookUrl(webhookKey) {
  // 1. Primary: Read from settings.json (configured via webhooks.html)
  const filePath = path.join(DATA_DIR, 'settings.json');
  if (fs.existsSync(filePath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (settings.webhooks && settings.webhooks[webhookKey] && settings.webhooks[webhookKey].trim()) {
        return settings.webhooks[webhookKey].trim();
      }
    } catch (e) {}
  }

  // 2. Secondary fallback: .env variables
  const envMap = {
    alertsWebhook: process.env.ALERTS_WEBHOOK_URL,
    applicationWebhook: process.env.APP_WEBHOOK_URL
  };

  return envMap[webhookKey] ? envMap[webhookKey].trim() : null;
}

async function sendDiscordNotification(webhookKey, embedData, contentMessage = "") {
  const url = getWebhookUrl(webhookKey);
  if (!url) {
    console.warn(`[Discord Webhook] No active URL found for '${webhookKey}'. Check webhooks.html or settings.json`);
    return false;
  }

  try {
    const payload = {
      embeds: [{
        title: embedData.title,
        description: embedData.description,
        color: embedData.color || 16737792,
        timestamp: new Date().toISOString(),
        footer: { text: "San Andreas Department of Transportation • Dispatch CAD" }
      }]
    };

    // Only attach content if text is actually present (Discord rejects empty string content)
    if (contentMessage && contentMessage.trim()) {
      payload.content = contentMessage.trim();
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error(`[Discord Webhook Error] (${webhookKey}) HTTP ${res.status}:`, errorText);
      return false;
    }

    console.log(`[Discord Webhook Success] Dispatched message to '${webhookKey}'`);
    return true;
  } catch (err) {
    console.error(`[Discord Webhook Error] Failed to send notification (${webhookKey}):`, err.message);
    return false;
  }
}

// -----------------------------------------------------------------------------
// WEBHOOK SETTINGS ROUTES (settings.json is primary)
// -----------------------------------------------------------------------------
app.get('/api/settings/webhooks', (req, res) => {
  const filePath = path.join(DATA_DIR, 'settings.json');
  let fileWebhooks = { alertsWebhook: '', applicationWebhook: '' };
  
  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      fileWebhooks = data.webhooks || fileWebhooks;
    } catch (e) {}
  }

  res.json({
    alertsWebhook: fileWebhooks.alertsWebhook || process.env.ALERTS_WEBHOOK_URL || '',
    applicationWebhook: fileWebhooks.applicationWebhook || process.env.APP_WEBHOOK_URL || ''
  });
});

app.put('/api/settings/webhooks', (req, res) => {
  const filePath = path.join(DATA_DIR, 'settings.json');
  let settings = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : {};
  
  settings.webhooks = {
    alertsWebhook: req.body.alertsWebhook ? req.body.alertsWebhook.trim() : '',
    applicationWebhook: req.body.applicationWebhook ? req.body.applicationWebhook.trim() : ''
  };

  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2));
  console.log('[Settings] Updated webhooks in settings.json:', settings.webhooks);
  res.json({ result: 'success', webhooks: settings.webhooks });
});

app.post('/api/settings/test-webhook', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Webhook URL is required' });
  try {
    const response = await fetch(url.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: "⚡ SADOT Dispatch Webhook Test",
          description: "Connection established successfully with the SADOT CAD system.",
          color: 16737792,
          timestamp: new Date().toISOString()
        }]
      })
    });
    if (response.ok) res.json({ result: 'success' });
    else {
      const errText = await response.text();
      res.status(400).json({ error: `Discord rejected webhook (${response.status}): ${errText}` });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// -----------------------------------------------------------------------------
// FETCH ALL RECORDS
// -----------------------------------------------------------------------------
app.get('/api/:table', (req, res) => {
  const table = req.params.table;

  if (table === 'settings') {
    return res.status(403).json({ error: 'Direct access to settings is forbidden' });
  }

  const filePath = getFilePath(table);
  if (!fs.existsSync(filePath)) return res.json([]);

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    if (table === 'roster') {
      const sanitizedRoster = data.map(member => {
        const { portalPassword, ...safeFields } = member;
        return safeFields;
      });
      return res.json(sanitizedRoster);
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read data table' });
  }
});

// -----------------------------------------------------------------------------
// CREATE NEW RECORD
// -----------------------------------------------------------------------------
app.post('/api/:table', (req, res) => {
  const table = req.params.table;
  const filePath = getFilePath(table);
  
  let records = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : [];

  if (table === 'roster') {
    const appsPath = path.join(DATA_DIR, 'applications.json');
    let applications = fs.existsSync(appsPath) ? JSON.parse(fs.readFileSync(appsPath, 'utf8')) : [];

    const { icName, oocName, communityId, rank, isCivilianStaff, bypassAppCheck } = req.body;
    const isCivilian = isCivilianStaff || (rank && rank.toLowerCase().includes("civilian"));

    let matchingApp = null;
    if (!bypassAppCheck && !isCivilian) {
      matchingApp = applications.find(app => 
        app.icName?.trim().toLowerCase() === icName?.trim().toLowerCase() &&
        app.oocName?.trim().toLowerCase() === oocName?.trim().toLowerCase() &&
        app.communityId?.trim() === communityId?.trim()
      );

      if (!matchingApp) {
        return res.status(401).json({ error: 'Submission denied: No application found matching these details.' });
      }

      if (matchingApp.status !== 'Approved') {
        const reason = matchingApp.status === 'Denied' ? 'Your application was Denied.' : 'Your application is still Pending.';
        return res.status(403).json({ error: `Submission denied: ${reason}` });
      }
    } else if (communityId) {
      matchingApp = applications.find(app => app.communityId === communityId);
    }
    
    if (communityId && records.find(r => r.communityId === communityId)) {
      return res.status(400).json({ error: 'Submission denied: Community ID already registered on roster.' });
    }

    if (!req.body.subdivisionInterests || req.body.subdivisionInterests.length === 0) {
      if (matchingApp && matchingApp.subdivisions) {
        req.body.subdivisionInterests = matchingApp.subdivisions
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);
      } else {
        req.body.subdivisionInterests = [];
      }
    }
  }

  const newRecord = {
    id: Date.now().toString(),
    timestamp: new Date().toLocaleString(),
    ...req.body
  };

  let plainGeneratedPassword = null;

  if (table === 'roster') {
    const isCivilian = newRecord.isCivilianStaff || (newRecord.rank && newRecord.rank.toLowerCase().includes("civilian"));
    
    plainGeneratedPassword = newRecord.portalPassword ? newRecord.portalPassword.trim() : "";
    if (!plainGeneratedPassword) {
      const randomCode = Math.floor(1000 + Math.random() * 9000);
      const prefix = isCivilian ? 'CIV' : 'DOT';
      plainGeneratedPassword = `${prefix}-${newRecord.communityId || '9999'}-${randomCode}!`;
    }

    newRecord.portalPassword = bcrypt.hashSync(plainGeneratedPassword, 10);

    if (isCivilian) {
      newRecord.rank = "Civilian Staff";
      newRecord.isCivilianStaff = true;
      newRecord.hiddenFromRoster = true;
      newRecord.callsign = newRecord.callsign || "CIV-01";
      newRecord.certifications = newRecord.certifications && newRecord.certifications.length > 0 ? newRecord.certifications : [
        "CDL", "Flag Certified", "Rollback Certified", "Boom Wrecker Certified", 
        "Heavy Wrecker Certified", "Heavy Transport Certified", "Trailer Certified", "Probationary Certified"
      ];
      newRecord.subdivisionInterests = ALL_SUBDIVISIONS;
      newRecord.subdivisionAccess = ALL_SUBDIVISIONS;
    } else {
      newRecord.rank = newRecord.rank || "Probationary Operator (Cadet)";
      newRecord.callsign = newRecord.callsign || "UNASSIGNED";
      newRecord.certifications = newRecord.certifications || ["Probationary Certified"];
      newRecord.subdivisionInterests = Array.isArray(newRecord.subdivisionInterests) ? newRecord.subdivisionInterests : [];
      newRecord.subdivisionAccess = Array.isArray(newRecord.subdivisionAccess) && newRecord.subdivisionAccess.length > 0 
        ? newRecord.subdivisionAccess 
        : ["Highway Incident Management & Patrol"];
    }
  } else if (table === 'applications') {
    sendDiscordNotification('alertsWebhook', {
      title: '📋 New Employment Application Submitted',
      description: `**Applicant:** ${newRecord.icName}\n**OOC Name:** ${newRecord.oocName}\n**Community ID:** ${newRecord.communityId}\n**Discord ID:** ${newRecord.discord}`
    });
  } else if (table === 'work-orders') {
    sendDiscordNotification('alertsWebhook', {
      title: '🚨 New Work Order / Incident Request',
      description: `**Category:** ${newRecord.category || 'General'}\n**Location:** ${newRecord.location || 'N/A'}\n**Description:** ${newRecord.description || 'N/A'}`
    });
  }

  records.push(newRecord);
  fs.writeFileSync(filePath, JSON.stringify(records, null, 2));

  const responseRecord = { ...newRecord };
  if (plainGeneratedPassword) {
    responseRecord.portalPassword = plainGeneratedPassword;
  } else {
    delete responseRecord.portalPassword;
  }

  res.json({ result: 'success', record: responseRecord });
});

// -----------------------------------------------------------------------------
// UPDATE RECORD (With Awaited Webhook Dispatch)
// -----------------------------------------------------------------------------
app.put('/api/:table/:id', async (req, res) => {
  const { table, id } = req.params;
  const filePath = getFilePath(table);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });

  try {
    let records = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const index = records.findIndex(r => r.id === id);
    if (index === -1) return res.status(404).json({ error: 'Record not found' });

    let updates = { ...req.body };

    if (table === 'roster') {
      if (updates.rank && (updates.rank.toLowerCase().includes("civilian") || updates.isCivilianStaff)) {
        updates.isCivilianStaff = true;
        updates.hiddenFromRoster = updates.hiddenFromRoster !== undefined ? updates.hiddenFromRoster : true;
        updates.subdivisionInterests = ALL_SUBDIVISIONS;
        updates.subdivisionAccess = ALL_SUBDIVISIONS;
      }

      if (updates.subdivisionInterests !== undefined) {
        updates.subdivisionInterests = Array.isArray(updates.subdivisionInterests) ? updates.subdivisionInterests : [];
      }
      if (updates.subdivisionAccess !== undefined) {
        updates.subdivisionAccess = Array.isArray(updates.subdivisionAccess) ? updates.subdivisionAccess : [];
      }

      if (updates.portalPassword !== undefined) {
        const rawPass = updates.portalPassword.trim();
        if (rawPass && !rawPass.startsWith('$2a$') && !rawPass.startsWith('$2b$') && !rawPass.includes('PROTECTED')) {
          updates.portalPassword = bcrypt.hashSync(rawPass, 10);
        } else {
          delete updates.portalPassword;
        }
      }
    }

    // Archiving Work Orders
    if (table === 'work-orders' && (updates.status === 'Resolved' || updates.status === 'Cancelled')) {
      const archivePath = path.join(DATA_DIR, 'work-orders-archive.json');
      let archive = fs.existsSync(archivePath) ? JSON.parse(fs.readFileSync(archivePath, 'utf8')) : [];
      archive.push({ ...records[index], ...updates, archivedAt: new Date().toLocaleString() });
      fs.writeFileSync(archivePath, JSON.stringify(archive, null, 2));
      records = records.filter(r => r.id !== id);
      fs.writeFileSync(filePath, JSON.stringify(records, null, 2));
      return res.json({ result: 'success', archived: true });
    }

    // Application Status Notifications (Awaited with Full Error Reporting)
    let webhookSent = false;
    if (table === 'applications' && updates.status) {
      const appRecord = records[index];
      const isSameStatus = appRecord.status === updates.status;

      if (!isSameStatus && (updates.status === 'Approved' || updates.status === 'Denied')) {
        const isApproved = updates.status === 'Approved';
        const discordPing = appRecord.discord ? `<@${appRecord.discord.trim()}>` : '';
        const reviewMsg = updates.reviewMessage || 'No specific notes provided.';

        let descriptionText = '';

        if (isApproved) {
          descriptionText = `To: ${discordPing || 'Applicant'}
From: Department of Transportation Human Resources

Thank you for your application. We have officially reviewed your files, and we are pleased to offer you employment with the San Andreas Department of Transportation (SADOT).

Moving forward, your first priority is onboarding. 

Please note that you will be positioned as a Probationary Operator (Cadet) for your initial window on the department roster.

**MANDATORY NEW-HIRE STEPS**
1. **Complete the Roster Sign-up:**
Fill out the onboarding form below with your exact application details:
[San Andreas Department of Transportation Roster Signup](https://sa-dot.xyz/roster-signup)

⚠️ **WARNING:** Save your generated Employee Portal Password immediately!

2. **Set Up Uniforms & Vehicles:**
Consult the portal guides to configure authorized liveries and components.

3. **Review the SOP & Training Academy:**
Familiarize yourself with department directives and your subdivision field training manual.

4. **Request Training:**
Contact a Senior Operator or Supervisor to schedule your initial ride-along.

Welcome to the team!

Kind regards,
Division of Human Resources & Standards
San Andreas Department of Transportation`;
        } else {
          descriptionText = `To: ${discordPing || 'Applicant'}
From: Department of Transportation Human Resources

Thank you for submitting your application to the San Andreas Department of Transportation (SADOT). 

After careful review by our management team, we regret to inform you that your application has not been accepted at this time. 

**Reason / Reviewer Notes:**
> ${reviewMsg}

You are welcome to reapply after reviewing our departmental guidelines and standards.

Kind regards,
Division of Human Resources & Standards
San Andreas Department of Transportation`;
        }

        webhookSent = await sendDiscordNotification('applicationWebhook', {
          title: isApproved ? '✅ APPLICATION ACCEPTED' : '❌ APPLICATION DENIED',
          description: descriptionText,
          color: isApproved ? 3066993 : 15158332
        }, discordPing);
      }

      records[index] = { ...records[index], ...updates };
      fs.writeFileSync(filePath, JSON.stringify(records, null, 2));
      return res.json({ result: 'success', record: records[index], webhookSent: webhookSent });
    }

    records[index] = { ...records[index], ...updates };
    fs.writeFileSync(filePath, JSON.stringify(records, null, 2));

    const safeUpdated = { ...records[index] };
    delete safeUpdated.portalPassword;
    res.json({ result: 'success', record: safeUpdated });
  } catch (error) {
    console.error("PUT Error:", error);
    res.status(500).json({ error: error.message || 'Failed to update' });
  }
});

// -----------------------------------------------------------------------------
// LOGIN & AUTH (Supervisors level >= 3 receive ALL_SUBDIVISIONS)
// -----------------------------------------------------------------------------
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ success: false, error: 'Password is required' });

  const rosterPath = path.join(DATA_DIR, 'roster.json');
  if (!fs.existsSync(rosterPath)) return res.status(401).json({ success: false, error: 'No personnel found' });

  const roster = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));

  let matchedEmp = null;
  let fileNeedsUpdate = false;

  for (const emp of roster) {
    if (!emp.portalPassword) continue;

    if (emp.portalPassword.startsWith('$2a$') || emp.portalPassword.startsWith('$2b$')) {
      if (bcrypt.compareSync(password, emp.portalPassword)) {
        matchedEmp = emp;
        break;
      }
    } else {
      if (emp.portalPassword === password) {
        matchedEmp = emp;
        emp.portalPassword = bcrypt.hashSync(password, 10);
        fileNeedsUpdate = true;
        break;
      }
    }
  }

  if (fileNeedsUpdate) {
    fs.writeFileSync(rosterPath, JSON.stringify(roster, null, 2));
  }

  if (matchedEmp) {
    const rawRank = (matchedEmp.rank || "").toLowerCase();
    let mainRank = "Field Operator", level = 2;

    if (rawRank.includes("civilian") || matchedEmp.isCivilianStaff) {
      mainRank = "Civilian Staff";
      level = 4;
    } else if (rawRank.includes("commissioner") || rawRank.includes("chief") || rawRank.includes("command")) { 
      mainRank = "Command Staff"; 
      level = 4; 
    } else if (rawRank.includes("supervisor") || rawRank.includes("manager")) { 
      mainRank = "Supervisory Staff"; 
      level = 3; 
    } else if (rawRank.includes("probationary") || rawRank.includes("cadet")) { 
      mainRank = "Probationary Operator"; 
      level = 1; 
    }

    const allCerts = [
      "CDL", "Flag Certified", "Rollback Certified", "Boom Wrecker Certified", 
      "Heavy Wrecker Certified", "Heavy Transport Certified", "Trailer Certified", "Probationary Certified"
    ];

    // Supervisory Staff (level >= 3), Command, and Civilian Staff get access to all training guides
    const isLeadership = level >= 3 || mainRank === "Civilian Staff" || matchedEmp.isCivilianStaff;
    const finalSubdivAccess = isLeadership
      ? ALL_SUBDIVISIONS
      : (Array.isArray(matchedEmp.subdivisionAccess) && matchedEmp.subdivisionAccess.length > 0 
          ? matchedEmp.subdivisionAccess 
          : ["Highway Incident Management & Patrol"]);

    const finalSubdivInterests = isLeadership
      ? ALL_SUBDIVISIONS
      : (Array.isArray(matchedEmp.subdivisionInterests) ? matchedEmp.subdivisionInterests : []);

    res.json({ 
      success: true, 
      rank: mainRank, 
      level: level, 
      employeeName: matchedEmp.icName, 
      certifications: isLeadership 
        ? (matchedEmp.certifications && matchedEmp.certifications.length > 0 ? matchedEmp.certifications : allCerts) 
        : (matchedEmp.certifications || []),
      subdivisionInterests: finalSubdivInterests,
      subdivisionAccess: finalSubdivAccess
    });
  } else {
    res.status(401).json({ success: false, error: 'Invalid password' });
  }
});

// -----------------------------------------------------------------------------
// DELETE RECORD
// -----------------------------------------------------------------------------
app.delete('/api/:table/:id', (req, res) => {
  const filePath = getFilePath(req.params.table);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  let records = JSON.parse(fs.readFileSync(filePath, 'utf8')).filter(r => r.id !== req.params.id);
  fs.writeFileSync(filePath, JSON.stringify(records, null, 2));
  res.json({ result: 'success' });
});

app.listen(PORT, () => console.log(`SADOT Server running on port ${PORT}`));