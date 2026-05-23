/**
 * INSTANT TRIGGER: Send reminder messages to all pending Chandigarh event submissions
 * FIXED: Uses only 3 template parameters (name, event, city) - no schedule
 */
const { MongoClient } = require('mongodb');

const MONGODB_URI = 'mongodb+srv://Jashneadab:M3zowLyyoAtQXYxi@cluster0.aocwb3t.mongodb.net/?appName=Cluster0';
const MONGODB_DB_NAME = 'Jashneadab';

const WHATSAPP_API_URL = 'https://graph.facebook.com/v25.0';
const WHATSAPP_PHONE_NUMBER_ID = '1076272248900802';
const WHATSAPP_ACCESS_TOKEN = 'EAANiApjfrv4BRUofGkQmDZCuWnf9PNJ0BHGnPDrZAbhS5oGGc5of9rhb2tr7YPUL5pZCN28tJrcAceUKkEpHiCyEJNtuo4ssBS3fpXx4RpifGQD7t4w281oVdu0eZBnmkJwlygMdu2EBEGT1nMb4jdvyK0HNhbgpllcrC2D2KOcQyGHvA3d3U7bbrZBYPswRQ3gZDZD';
const WHATSAPP_REMINDER_TEMPLATE_NAME = 'reminder';
const WHATSAPP_TEMPLATE_LANGUAGE = 'en';

function normalizePhoneNumber(phone) {
  let cleaned = phone.replace(/[\s\-\(\)\+]/g, '');
  if (cleaned.startsWith('91') && cleaned.length === 12) return cleaned;
  if (cleaned.startsWith('0')) cleaned = cleaned.substring(1);
  if (cleaned.length === 10) cleaned = '91' + cleaned;
  return cleaned;
}

async function sendReminderWhatsApp(phone, variables) {
  const waPhone = normalizePhoneNumber(phone);
  const endpoint = `${WHATSAPP_API_URL}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  // Only 3 parameters: name, event, city (template does NOT accept schedule)
  const payload = {
    messaging_product: 'whatsapp',
    to: waPhone,
    type: 'template',
    template: {
      name: WHATSAPP_REMINDER_TEMPLATE_NAME,
      language: { code: WHATSAPP_TEMPLATE_LANGUAGE },
      components: [
        {
          type: 'body',
          parameters: variables.map(v => ({ type: 'text', text: (v || '').toString().trim() })),
        },
      ],
    },
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok || data?.error) {
      return {
        success: false,
        message: data?.error?.message || 'Failed to send message',
        messageId: null,
      };
    }

    const messageId = Array.isArray(data?.messages) ? data.messages[0]?.id : undefined;
    return {
      success: true,
      message: 'Message sent',
      messageId,
    };
  } catch (error) {
    return {
      success: false,
      message: error.message || 'Network error',
      messageId: null,
    };
  }
}

async function main() {
  const client = new MongoClient(MONGODB_URI);
  let sent = 0;
  let failed = 0;
  let total = 0;

  try {
    await client.connect();
    const db = client.db(MONGODB_DB_NAME);
    const submissionsCol = db.collection('submissions');

    // Get all pending Chandigarh submissions
    const pendingChandigarh = await submissionsCol.find({
      city: { $regex: /chandigarh/i },
      reminderStatus: 'pending',
    }).toArray();

    total = pendingChandigarh.length;
    console.log(`\n🔔 Found ${total} pending Chandigarh reminder(s) to send\n`);

    if (total === 0) {
      console.log('No pending reminders to send. Exiting.');
      return;
    }

    for (let i = 0; i < pendingChandigarh.length; i++) {
      const sub = pendingChandigarh[i];
      // Only 3 params: name, event, city
      const variables = [
        sub.name || '',
        sub.event || '',
        sub.city || '',
      ];

      process.stdout.write(`  [${i+1}/${total}] ${sub.name} (${sub.phone})... `);

      const result = await sendReminderWhatsApp(sub.phone, variables);

      if (result.success) {
        sent++;
        console.log(`✅ ${result.messageId}`);

        // Update MongoDB
        await submissionsCol.updateOne(
          { _id: sub._id },
          {
            $set: {
              reminderStatus: 'sent',
              reminderSentAt: new Date(),
              reminderError: null,
              reminderMessageId: result.messageId || null,
              reminderDeliveryStatus: 'accepted',
              updatedAt: new Date(),
            },
          }
        );

        // Also save to chats collection
        try {
          const chatsCollection = db.collection('chats');
          await chatsCollection.insertOne({
            phone: sub.phone,
            normalizedPhone: normalizePhoneNumber(sub.phone),
            contactName: sub.name,
            direction: 'outbound',
            type: 'template',
            text: `Reminder: ${sub.event} in ${sub.city}`,
            templateName: WHATSAPP_REMINDER_TEMPLATE_NAME,
            messageId: result.messageId || null,
            deliveryStatus: 'accepted',
            error: null,
            isRead: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        } catch (chatErr) {
          // non-critical
        }
      } else {
        failed++;
        console.log(`❌ ${result.message}`);

        // Update MongoDB with failure
        await submissionsCol.updateOne(
          { _id: sub._id },
          {
            $set: {
              reminderStatus: 'failed',
              reminderError: result.message,
              reminderDeliveryStatus: 'failed',
              updatedAt: new Date(),
            },
          }
        );
      }

      // Small delay between sends to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    console.log(`\n📊 Results: ${sent} sent ✅, ${failed} failed ❌, ${total} total`);
    console.log(`\n✅ Done!`);

  } finally {
    await client.close();
  }
}

main().catch(err => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
