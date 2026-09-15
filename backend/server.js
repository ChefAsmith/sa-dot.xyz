const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

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

// Discord Notification Helper
async function sendDiscordNotification(webhookKey, embedData, contentMessage = "") {
  const filePath = path.join(DATA_DIR, 'settings.json');
  if (!fs.existsSync(filePath)) return;
  try {
    const settings = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const url = settings.webhooks && settings.webhooks[webhookKey];
    if (!url) return;

    const payload = {
      content: contentMessage, 
      embeds: [{
        title: embedData.title,
        description: embedData.description,
        color: embedData.color || 16737792,
        timestamp: new Date().toISOString(),
        footer: { text: "San Andreas Department of Transportation • Dispatch CAD" }
      }]
    };

    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error(`Failed to send Discord notification (${webhookKey}):`, err.message);
  }
}

// 1. WEBHOOK SETTINGS
app.get('/api/settings/webhooks', (req, res) => {
  const filePath = path.join(DATA_DIR, 'settings.json');
  if (!fs.existsSync(filePath)) return res.json({ alertsWebhook: '', applicationWebhook: '' });
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  res.json(data.webhooks || { alertsWebhook: '', applicationWebhook: '' });
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

// 2. FETCH ALL RECORDS
app.get('/api/:table', (req, res) => {
  const table = req.params.table;
  const filePath = getFilePath(table);
  if (!fs.existsSync(filePath)) return res.json([]);
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    res.json(data);
  } catch (error) { res.status(500).json({ error: 'Failed to read data table' }); }
});

// 3. CREATE NEW RECORD (Signups & Applications)
app.post('/api/:table', (req, res) => {
  const table = req.params.table;
  const filePath = getFilePath(table);
  
  let records = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : [];

  // SECURITY CROSS-CHECK FOR ROSTER
  if (table === 'roster') {
    const appsPath = path.join(DATA_DIR, 'applications.json');
    let applications = fs.existsSync(appsPath) ? JSON.parse(fs.readFileSync(appsPath, 'utf8')) : [];

    const { icName, oocName, communityId } = req.body;

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
    
    if (records.find(r => r.communityId === communityId)) {
        return res.status(400).json({ error: 'Submission denied: Already registered on roster.' });
    }
  }

  const newRecord = {
    id: Date.now().toString(),
    timestamp: new Date().toLocaleString(),
    ...req.body
  };

  if (table === 'roster') {
    newRecord.rank = "Probationary Operator (Cadet)";
    newRecord.callsign = "UNASSIGNED";
    newRecord.certifications = ["Probationary Certified"];
    const randomCode = Math.floor(1000 + Math.random() * 9000);
    newRecord.portalPassword = `DOT-${newRecord.communityId || '9999'}-${randomCode}!`;
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
  res.json({ result: 'success', record: newRecord });
});

// 4. UPDATE RECORD (Approval/Denial logic)
app.put('/api/:table/:id', (req, res) => {
  const { table, id } = req.params;
  const filePath = getFilePath(table);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });

  try {
    let records = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const index = records.findIndex(r => r.id === id);
    if (index === -1) return res.status(404).json({ error: 'Record not found' });

    let updates = { ...req.body };

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

    // Application Status Notifications (Approved vs Denied templates)
    if (table === 'applications' && updates.status) {
      const app = records[index];
      const isApproved = updates.status === 'Approved';
      const discordPing = app.discord ? `<@${app.discord}>` : 'Applicant';
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
    res.json({ result: 'success', record: records[index] });
  } catch (error) { res.status(500).json({ error: 'Failed to update' }); }
});

// 5. LOGIN & AUTH
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  const rosterPath = path.join(DATA_DIR, 'roster.json');
  if (!fs.existsSync(rosterPath)) return res.status(401).json({ success: false, error: 'No personnel found' });

  const roster = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
  const emp = roster.find(e => e.portalPassword === password);

  if (emp) {
    const rawRank = (emp.rank || "").toLowerCase();
    let mainRank = "Field Operator", level = 2;
    if (rawRank.includes("commissioner") || rawRank.includes("chief") || rawRank.includes("command")) { mainRank = "Command Staff"; level = 4; }
    else if (rawRank.includes("supervisor") || rawRank.includes("manager")) { mainRank = "Supervisory Staff"; level = 3; }
    else if (rawRank.includes("probationary") || rawRank.includes("cadet")) { mainRank = "Probationary Operator"; level = 1; }

    res.json({ success: true, rank: mainRank, level: level, employeeName: emp.icName, certifications: emp.certifications || [] });
  } else {
    res.status(401).json({ success: false, error: 'Invalid password' });
  }
});

// 6. DELETE RECORD
app.delete('/api/:table/:id', (req, res) => {
  const filePath = getFilePath(req.params.table);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  let records = JSON.parse(fs.readFileSync(filePath, 'utf8')).filter(r => r.id !== req.params.id);
  fs.writeFileSync(filePath, JSON.stringify(records, null, 2));
  res.json({ result: 'success' });
});

app.listen(PORT, () => console.log(`SADOT Server running on port ${PORT}`));