/**
 * Check MongoDB for Chandigarh event submissions and their reminder status
 */
const { MongoClient } = require('mongodb');

const MONGODB_URI = 'mongodb+srv://Jashneadab:M3zowLyyoAtQXYxi@cluster0.aocwb3t.mongodb.net/?appName=Cluster0';
const MONGODB_DB_NAME = 'Jashneadab';

async function main() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(MONGODB_DB_NAME);

    // Check cities for Chandigarh
    const cities = await db.collection('cities').find({}).toArray();
    console.log('\n=== ALL CITIES ===');
    cities.forEach(c => console.log(`  ${c._id} | ${c.name} | active: ${c.isActive}`));

    const chandigarhCity = cities.find(c => c.nameLower === 'chandigarh' || c.name.toLowerCase().includes('chandigarh'));
    console.log('\n=== CHANDIGARH CITY ===');
    console.log(chandigarhCity || 'NOT FOUND');

    // Check events
    const events = await db.collection('events').find({}).toArray();
    console.log('\n=== ALL EVENTS ===');
    events.forEach(e => console.log(`  ${e._id} | ${e.name} | cityId: ${e.cityId} | active: ${e.isActive} | date: ${e.eventDate}`));

    // Check submissions with pending reminders
    const pendingReminders = await db.collection('submissions').find({ reminderStatus: 'pending' }).toArray();
    console.log(`\n=== PENDING REMINDER SUBMISSIONS (${pendingReminders.length}) ===`);
    pendingReminders.forEach(s => {
      console.log(`  ${s._id} | ${s.name} | ${s.phone} | city: ${s.city} | event: ${s.event} | eventAt: ${s.eventAt} | reminder: ${s.reminderStatus}`);
    });

    // Check all submissions related to Chandigarh
    const chandigarhSubs = await db.collection('submissions').find({
      $or: [
        { city: { $regex: /chandigarh/i } },
        { event: { $regex: /chandigarh/i } },
      ]
    }).toArray();
    console.log(`\n=== CHANDIGARH SUBMISSIONS (${chandigarhSubs.length}) ===`);
    chandigarhSubs.forEach(s => {
      console.log(`  ${s._id} | ${s.name} | ${s.phone} | city: ${s.city} | event: ${s.event} | eventAt: ${s.eventAt} | reminderStatus: ${s.reminderStatus} | reminderSentAt: ${s.reminderSentAt}`);
    });

    // Show current time calculations
    const now = new Date();
    const targetHours = 23;
    const windowMinutes = 90;
    const targetMs = targetHours * 60 * 60 * 1000;
    const windowMs = windowMinutes * 60 * 1000;

    const start = new Date(now.getTime() + targetMs - windowMs / 2);
    const end = new Date(now.getTime() + targetMs + windowMs / 2);

    console.log('\n=== TIME WINDOW ANALYSIS ===');
    console.log(`  Now (UTC): ${now.toISOString()}`);
    console.log(`  Now (IST): ${now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
    console.log(`  Normal window start: ${start.toISOString()}`);
    console.log(`  Normal window end:   ${end.toISOString()}`);
    console.log(`  Late window (now to now+23h): ${now.toISOString()} to ${new Date(now.getTime() + targetMs).toISOString()}`);

    // Check what the event tomorrow at 2 PM IST would be
    // Tomorrow is May 24, 2026. 2 PM IST = 8:30 AM UTC
    console.log('\n=== EXPECTED EVENT TIME ===');
    console.log(`  Tomorrow 2:00 PM IST = 2026-05-24T08:30:00.000Z (UTC)`);
    console.log(`  23h before event = 2026-05-23T09:30:00.000Z (UTC) = ~3:00 PM IST today`);

    // Check all submissions to see eventAt values
    const allSubs = await db.collection('submissions').find({}).sort({ createdAt: -1 }).limit(20).toArray();
    console.log(`\n=== RECENT 20 SUBMISSIONS ===`);
    allSubs.forEach(s => {
      console.log(`  ${s._id} | ${s.name} | city: ${s.city} | event: ${s.event} | eventAt: ${s.eventAt} | reminderStatus: ${s.reminderStatus}`);
    });

  } finally {
    await client.close();
  }
}

main().catch(console.error);
