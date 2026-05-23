/**
 * 1. Reset reminder statuses that were incorrectly marked as 'failed' by the previous script
 * 2. Test different parameter counts to find the correct one for the 'reminder' template
 */
const { MongoClient } = require('mongodb');

const MONGODB_URI = 'mongodb+srv://Jashneadab:M3zowLyyoAtQXYxi@cluster0.aocwb3t.mongodb.net/?appName=Cluster0';
const MONGODB_DB_NAME = 'Jashneadab';

const WHATSAPP_API_URL = 'https://graph.facebook.com/v25.0';
const WHATSAPP_PHONE_NUMBER_ID = '1076272248900802';
const WHATSAPP_ACCESS_TOKEN = 'EAANiApjfrv4BRUofGkQmDZCuWnf9PNJ0BHGnPDrZAbhS5oGGc5of9rhb2tr7YPUL5pZCN28tJrcAceUKkEpHiCyEJNtuo4ssBS3fpXx4RpifGQD7t4w281oVdu0eZBnmkJwlygMdu2EBEGT1nMb4jdvyK0HNhbgpllcrC2D2KOcQyGHvA3d3U7bbrZBYPswRQ3gZDZD';
const TEST_PHONE = '919211625495'; // Use the business number for testing

async function testTemplateParams(paramCount, params) {
  const endpoint = `${WHATSAPP_API_URL}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to: TEST_PHONE,
    type: 'template',
    template: {
      name: 'reminder',
      language: { code: 'en' },
    },
  };

  if (paramCount > 0) {
    payload.template.components = [
      {
        type: 'body',
        parameters: params.slice(0, paramCount).map(v => ({ type: 'text', text: v })),
      },
    ];
  }

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
    return { paramCount, ok: response.ok, data };
  } catch (error) {
    return { paramCount, ok: false, error: error.message };
  }
}

async function main() {
  // First, let's also check the template details via the API
  const businessId = '654417264415770'; // Will try to get templates
  const testParams = ['TestUser', 'TestEvent', 'TestCity', '24 May, 2026 2:00 PM', 'Extra'];

  console.log('=== Testing reminder template with different parameter counts ===\n');

  // Test 0, 1, 2, 3, 4, 5 parameters
  for (let count = 0; count <= 5; count++) {
    const result = await testTemplateParams(count, testParams);
    const status = result.ok ? '✅ SUCCESS' : '❌ FAILED';
    const errorMsg = result.data?.error?.message || '';
    const msgId = result.data?.messages?.[0]?.id || '';
    console.log(`  ${count} params: ${status} ${errorMsg || msgId}`);
    
    if (result.ok) {
      console.log(`\n  🎯 CORRECT PARAM COUNT: ${count}\n`);
      break;
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Now reset the failed records back to pending
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(MONGODB_DB_NAME);
    const submissions = db.collection('submissions');

    // Reset the ones that were marked as failed by our script (with the specific error message)
    const resetResult = await submissions.updateMany(
      {
        city: { $regex: /chandigarh/i },
        reminderStatus: 'failed',
        reminderError: '(#132000) Number of parameters does not match the expected number of params',
      },
      {
        $set: {
          reminderStatus: 'pending',
          reminderSentAt: null,
          reminderError: null,
          reminderMessageId: null,
          reminderDeliveryStatus: 'pending',
          updatedAt: new Date(),
        },
      }
    );

    console.log(`\n✅ Reset ${resetResult.modifiedCount} incorrectly failed submissions back to pending`);
  } finally {
    await client.close();
  }
}

main().catch(console.error);
