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

// -----------------------------------------------------------------------------
// AES-256-GCM Encryption Helper (For At-Rest Data Protection)
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
// Discord Notification Helper (Checks .env first, then settings.json)
// -----------------------------------------------------------------------------
function getWebhookUrl(webhookKey) {
  const envMap = {
    alertsWebhook: process.env.ALERTS_WEBHOOK_URL,
    applicationWebhook: process.env.APP_WEBHOOK_URL
  };

  if (envMap[webhookKey]) return envMap[webhookKey];

  const filePath = path.join(DATA_DIR, 'settings.json');
  if (fs.existsSync(filePath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return settings.webhooks && settings.webhooks[webhookKey];
    } catch (e) {}
  }
  return null;
}

async function sendDiscordNotification(webhookKey, embedData, contentMessage = "") {
  const url = getWebhookUrl(webhookKey);
  if (!url) return;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: contentMessage,
        embeds: [{
          title: embedData.title,
          description: embedData.description,
          color: embedData.color || 16737792,
          timestamp: new Date().toISOString(),
          footer: { text: "San Andreas Department of Transportation • Dispatch CAD" }
        }]
      })
    });
  } catch (err) {
    console.error(`Failed to send Discord notification (${webhookKey}):`, err.message);
  }
}

// -----------------------------------------------------------------------------
// WEBHOOK SETTINGS
// -----------------------------------------------------------------------------
app.get('/api/settings/webhooks', (req, res) => {
  const alertsWebhook = process.env.ALERTS_WEBHOOK_URL || '';
  const applicationWebhook = process.env.APP_WEBHOOK_URL || '';

  const filePath = path.join(DATA_DIR, 'settings.json');
  let fileWebhooks = { alertsWebhook: '', applicationWebhook: '' };
  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      fileWebhooks = data.webhooks || fileWebhooks;
    } catch (e) {}
  }

  res.json({
    alertsWebhook: alertsWebhook || fileWebhooks.alertsWebhook,
    applicationWebhook: applicationWebhook || fileWebhooks.applicationWebhook
  });
});

app.put('/api/settings/webhooks', (req, res) => {
  const filePath = path.join(DATA_DIR, 'settings.json');
  let settings = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : {};
  settings.webhooks = {
    alertsWebhook: req.body.alertsWebhook || '',
    applicationWebhook: req.body.applicationWebhook || ''
  };
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2));
  res.json({ result: 'success', webhooks: settings.webhooks });
});

app.post('/api/settings/test-webhook', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Webhook URL is required' });
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: "⚡ SADOT Dispatch Webhook Test",
          description: "Connection established successfully.",
          color: 16737792,
          timestamp: new Date().toISOString()
        }]
      })
    });
    if (response.ok) res.json({ result: 'success' });
    else res.status(400).json({ error: 'Discord rejected webhook URL' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// -----------------------------------------------------------------------------
// FETCH ALL RECORDS (With Data Sanitization)
// -----------------------------------------------------------------------------
app.get('/api/:table', (req, res) => {
  const table = req.params.table;

  // Block direct public dumps of server settings/webhooks
  if (table === 'settings') {
    return res.status(403).json({ error: 'Direct access to settings is forbidden' });
  }

  const filePath = getFilePath(table);
  if (!fs.existsSync(filePath)) return res.json([]);

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    // Strip out passwords when serving the roster
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
// CREATE NEW RECORD (Signups, Applications, & Roster Accounts)
// -----------------------------------------------------------------------------
app.post('/api/:table', (req, res) => {
  const table = req.params.table;
  const filePath = getFilePath(table);
  
  let records = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : [];

  // SECURITY CROSS-CHECK FOR ROSTER
  if (table === 'roster') {
    const appsPath = path.join(DATA_DIR, 'applications.json');
    let applications = fs.existsSync(appsPath) ? JSON.parse(fs.readFileSync(appsPath, 'utf8')) : [];

    const { icName, oocName, communityId, rank, isCivilianStaff, bypassAppCheck } = req.body;
    const isCivilian = isCivilianStaff || (rank && rank.toLowerCase().includes("civilian"));

    if (!bypassAppCheck && !isCivilian) {
      const matchingApp = applications.find(app => 
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
    }
    
    if (communityId && records.find(r => r.communityId === communityId)) {
      return res.status(400).json({ error: 'Submission denied: Community ID already registered on roster.' });
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
    
    // Capture or generate plaintext password
    plainGeneratedPassword = newRecord.portalPassword ? newRecord.portalPassword.trim() : "";
    if (!plainGeneratedPassword) {
      const randomCode = Math.floor(1000 + Math.random() * 9000);
      const prefix = isCivilian ? 'CIV' : 'DOT';
      plainGeneratedPassword = `${prefix}-${newRecord.communityId || '9999'}-${randomCode}!`;
    }

    // Securely hash the password before disk storage
    newRecord.portalPassword = bcrypt.hashSync(plainGeneratedPassword, 10);

    if (isCivilian) {
      newRecord.rank = "Civilian Staff";
      newRecord.isCivilianStaff = true;
      newRecord.hiddenFromRoster = true;
      newRecord.callsign = newRecord.callsign || "CIV-01";
      newRecord.certifications = newRecord.certifications && newRecord.certifications.length > 0 ? newRecord.certifications : [
        "CDL",
        "Flag Certified",
        "Rollback Certified",
        "Boom Wrecker Certified",
        "Heavy Wrecker Certified",
        "Heavy Transport Certified",
        "Trailer Certified",
        "Probationary Certified"
      ];
    } else {
      newRecord.rank = newRecord.rank || "Probationary Operator (Cadet)";
      newRecord.callsign = newRecord.callsign || "UNASSIGNED";
      newRecord.certifications = newRecord.certifications || ["Probationary Certified"];
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

  // If a password was generated, return plaintext ONCE so roster-signup.html can show it to the user
  const responseRecord = { ...newRecord };
  if (plainGeneratedPassword) {
    responseRecord.portalPassword = plainGeneratedPassword;
  } else {
    delete responseRecord.portalPassword;
  }

  res.json({ result: 'success', record: responseRecord });
});

// -----------------------------------------------------------------------------
// UPDATE RECORD (With Password Re-Hashing on Edit)
// -----------------------------------------------------------------------------
app.put('/api/:table/:id', (req, res) => {
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

    // Application Status Notifications
    if (table === 'applications' && updates.status) {
      const appRecord = records[index];
      const isSameStatus = appRecord.status === updates.status;

      if (!isSameStatus && (updates.status === 'Approved' || updates.status === 'Denied')) {
        const isApproved = updates.status === 'Approved';
        const discordPing = appRecord.discord ? `<@${appRecord.discord}>` : 'Applicant';
        const reviewMsg = updates.reviewMessage || 'No specific notes provided.';

        let descriptionText = '';

        if (isApproved) {
          descriptionText = `To: ${discordPing}
From: Department of Transportation Human Resources

Thank you for your application. We have officially reviewed your files, and we are pleased to offer you employment with the San Andreas Department of Transportation (SADOT).

Moving forward, your first priority is onboarding. 

Please note that you will be positioned as a Probationary Operator (Cadet) for your initial window on the department roster. This probationary period allows command and supervisors to assess your field skills, navigation competency, and protocol compliance.

**MANDATORY NEW-HIRE STEPS**
To complete your entry prerequisites and secure active deployment status, you are strictly required to clear the following onboarding modules:

1. **Complete the Roster Sign-up:**
Fill out the official onboarding form below using your exact application details (OOC Name, In-Character Name, and Community ID). 

⚠️ **WARNING:** Upon successful submission, the system will generate your unique **Employee Portal Password**. You must copy, save, and secure this password immediately! **If you lose this password, you will not be able to log into the Employee Portal.**

[San Andreas Department of Transportation Roster Signup](https://sa-dot.xyz/roster-signup)

2. **Create Your Uniform and Vehicles:**
Set up your required department uniform and authorized vehicle configurations according to agency standards.

3. **Review the SOP Manual:**
Read through the SOP Manual found within the portal to familiarize yourself with agency protocols.

4. **Request Training:**
After completing your signup and reviewing the manual, please request a Senior Operator or above to begin your training. *(Note: Please be aware that it may take some time for your training to be scheduled).*

Welcome to the team. Let's keep San Andreas moving safely.

Kind regards,
Division of Human Resources & Standards
San Andreas Department of Transportation`;
        } else {
          descriptionText = `To: ${discordPing}
From: Department of Transportation Human Resources

Thank you for submitting your application to the San Andreas Department of Transportation (SADOT). 

After careful review by our human resources and management team, we regret to inform you that your application has not been accepted at this time. 

**Reason / Reviewer Notes:**
> ${reviewMsg}

We appreciate the time and effort you put into your application packet. You are welcome to reapply after reviewing our departmental guidelines and standards.

Kind regards,
Division of Human Resources & Standards
San Andreas Department of Transportation`;
        }

        sendDiscordNotification('applicationWebhook', {
          title: isApproved ? '✅ APPLICATION ACCEPTED' : '❌ APPLICATION DENIED',
          description: descriptionText,
          color: isApproved ? 3066993 : 15158332
        }, discordPing);
      }

      records[index] = { ...records[index], ...updates };
      fs.writeFileSync(filePath, JSON.stringify(records, null, 2));
      return res.json({ result: 'success', record: records[index], webhookSent: !isSameStatus });
    }

    records[index] = { ...records[index], ...updates };
    fs.writeFileSync(filePath, JSON.stringify(records, null, 2));

    const safeUpdated = { ...records[index] };
    delete safeUpdated.portalPassword;
    res.json({ result: 'success', record: safeUpdated });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update' });
  }
});

// -----------------------------------------------------------------------------
// LOGIN & AUTH (Bcrypt Verification with Auto-Migration)
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

    // Check if stored password is a bcrypt hash
    if (emp.portalPassword.startsWith('$2a$') || emp.portalPassword.startsWith('$2b$')) {
      if (bcrypt.compareSync(password, emp.portalPassword)) {
        matchedEmp = emp;
        break;
      }
    } else {
      // Legacy plaintext password check
      if (emp.portalPassword === password) {
        matchedEmp = emp;
        // Automatically upgrade stored plaintext password to bcrypt hash
        emp.portalPassword = bcrypt.hashSync(password, 10);
        fileNeedsUpdate = true;
        break;
      }
    }
  }

  // Persist upgraded password hash to roster.json if migrated
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
      "CDL",
      "Flag Certified",
      "Rollback Certified",
      "Boom Wrecker Certified",
      "Heavy Wrecker Certified",
      "Heavy Transport Certified",
      "Trailer Certified",
      "Probationary Certified"
    ];

    res.json({ 
      success: true, 
      rank: mainRank, 
      level: level, 
      employeeName: matchedEmp.icName, 
      certifications: (mainRank === "Civilian Staff" || matchedEmp.isCivilianStaff) 
        ? (matchedEmp.certifications && matchedEmp.certifications.length > 0 ? matchedEmp.certifications : allCerts) 
        : (matchedEmp.certifications || []) 
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