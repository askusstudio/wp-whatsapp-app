/**
 * Server-side reminder scheduler.
 *
 * This module runs a periodic check (default every 15 minutes) that
 * automatically dispatches reminder messages for events coming up
 * within the configured window.
 *
 * It is imported by the instrumentation hook so that it starts
 * automatically when the Next.js server boots.
 */

import { saveChatMessage } from "@/lib/chats"
import { getReminderMessage } from "@/lib/templates"
import { getPendingReminderSubmissions, markReminderStatus } from "@/lib/submissions"
import { sendReminderWhatsApp } from "@/lib/whatsapp"

let schedulerStarted = false
let intervalRef: ReturnType<typeof setInterval> | null = null

function formatSchedule(iso?: string | null) {
  if (!iso) return ""
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""

  const timeZone = process.env.APP_TIMEZONE || "Asia/Kolkata"
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(date)
}

async function runReminders() {
  const now = new Date()
  const targetHours = Number(process.env.REMINDER_TARGET_HOURS || "24")
  const windowMinutes = Number(process.env.REMINDER_WINDOW_MINUTES || "90")
  const sendIfLate = (process.env.REMINDER_SEND_IF_WITHIN_TARGET || "").toLowerCase()
  const allowLateSends = sendIfLate === "1" || sendIfLate === "true" || sendIfLate === "yes"

  const targetMs = targetHours * 60 * 60 * 1000
  const windowMs = windowMinutes * 60 * 1000

  // Normal window: events that are ~targetHours away (±half-window)
  const start = new Date(now.getTime() + targetMs - windowMs / 2)
  const end = new Date(now.getTime() + targetMs + windowMs / 2)

  const targets = await getPendingReminderSubmissions(start, end)

  // Late/catch-up sends: also include events that are imminent, ongoing, or recently
  // passed (up to 48h ago) that never received a reminder. This covers scenarios where
  // the server was down or restarted and missed the normal window entirely.
  const CATCHUP_HOURS = 48
  const catchupStart = new Date(now.getTime() - CATCHUP_HOURS * 60 * 60 * 1000)
  const lateTargets = allowLateSends
    ? await getPendingReminderSubmissions(catchupStart, new Date(now.getTime() + targetMs))
    : []

  const allTargets = allowLateSends ? [...targets, ...lateTargets] : targets
  const uniqueTargets = Array.from(new Map(allTargets.map((t) => [t.id, t])).values())

  if (uniqueTargets.length === 0) {
    return { sent: 0, failed: 0 }
  }

  let sent = 0
  let failed = 0

  for (const submission of uniqueTargets) {
    try {
      const message = getReminderMessage({
        name: submission.name,
        eventAt: submission.eventAt ? new Date(submission.eventAt) : null,
      })

      const result = await sendReminderWhatsApp(submission.phone, message, {
        name: submission.name,
        event: submission.event || "",
        city: submission.city || "",
        schedule: formatSchedule(submission.eventAt || null),
      })

      await markReminderStatus(submission.id, result.success, result.success ? undefined : result.message, {
        messageId: result.messageId,
        deliveryStatus: result.deliveryStatus,
      })

      await saveChatMessage({
        phone: submission.phone,
        contactName: submission.name,
        direction: "outbound",
        type: "template",
        text: message,
        templateName: process.env.WHATSAPP_REMINDER_TEMPLATE_NAME || "reminder",
        messageId: result.messageId || null,
        deliveryStatus: result.deliveryStatus || (result.success ? "accepted" : "failed"),
        error: result.success ? null : result.message,
      })

      if (result.success) {
        sent++
      } else {
        failed++
      }
    } catch (error) {
      console.error("[reminder-scheduler] Send failure for", submission.id, error)
      await markReminderStatus(submission.id, false, "Unexpected reminder dispatch error")
      failed++
    }
  }

  return { sent, failed }
}

export function startReminderScheduler() {
  if (schedulerStarted) return

  const intervalMs = Number(process.env.REMINDER_CHECK_INTERVAL_MS || String(15 * 60 * 1000)) // default 15 min

  console.log(`[reminder-scheduler] Starting — checking every ${Math.round(intervalMs / 60000)} minutes`)
  schedulerStarted = true

  // Run immediately on startup
  runReminders()
    .then((result) => {
      console.log(`[reminder-scheduler] Initial run complete — sent: ${result.sent}, failed: ${result.failed}`)
    })
    .catch((err) => {
      console.error("[reminder-scheduler] Initial run error:", err)
    })

  // Then run on interval
  intervalRef = setInterval(() => {
    runReminders()
      .then((result) => {
        if (result.sent > 0 || result.failed > 0) {
          console.log(`[reminder-scheduler] Periodic run — sent: ${result.sent}, failed: ${result.failed}`)
        }
      })
      .catch((err) => {
        console.error("[reminder-scheduler] Periodic run error:", err)
      })
  }, intervalMs)
}

export function stopReminderScheduler() {
  if (intervalRef) {
    clearInterval(intervalRef)
    intervalRef = null
  }
  schedulerStarted = false
}
