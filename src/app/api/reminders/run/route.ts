import { NextRequest, NextResponse } from "next/server"
import { saveChatMessage } from "@/lib/chats"
import { getReminderMessage } from "@/lib/templates"
import { getPendingReminderSubmissions, markReminderStatus } from "@/lib/submissions"
import { sendReminderWhatsApp } from "@/lib/whatsapp"

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

function isAuthorized(request: NextRequest) {
  const expectedSecret = process.env.CRON_SECRET
  if (!expectedSecret) {
    return true
  }

  const cronHeader = request.headers.get("x-cron-secret")
  const authHeader = request.headers.get("authorization")
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : ""

  return cronHeader === expectedSecret || bearer === expectedSecret
}

async function runReminderDispatch() {
  const now = new Date()
  const targetHours = Number(process.env.REMINDER_TARGET_HOURS || "24")
  const windowMinutes = Number(process.env.REMINDER_WINDOW_MINUTES || "90")
  const sendIfLate = (process.env.REMINDER_SEND_IF_WITHIN_TARGET || "").toLowerCase()

  const targetMs = targetHours * 60 * 60 * 1000
  const windowMs = windowMinutes * 60 * 1000

  // Select events that are ~24h away (tight window for cron reliability).
  // If cron runs every hour, a 90-minute window avoids misses.
  const start = new Date(now.getTime() + targetMs - windowMs / 2)
  const end = new Date(now.getTime() + targetMs + windowMs / 2)

  const targets = await getPendingReminderSubmissions(start, end)
  const allowLateSends = sendIfLate === "1" || sendIfLate === "true" || sendIfLate === "yes"

  // Optional: catch-up for late/missed reminders. Include events that are imminent,
  // ongoing, or recently passed (up to 48h ago) that never received a reminder.
  const CATCHUP_HOURS = 48
  const catchupStart = new Date(now.getTime() - CATCHUP_HOURS * 60 * 60 * 1000)
  const lateTargets = allowLateSends
    ? await getPendingReminderSubmissions(catchupStart, new Date(now.getTime() + targetMs))
    : []

  const allTargets = allowLateSends ? [...targets, ...lateTargets] : targets
  const uniqueTargets = Array.from(new Map(allTargets.map((t) => [t.id, t])).values())
  const outcomes: Array<{ submissionId: string; success: boolean; message: string; messageId?: string; deliveryStatus?: string }> = []

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

      outcomes.push({
        submissionId: submission.id,
        success: result.success,
        message: result.message,
        messageId: result.messageId,
        deliveryStatus: result.deliveryStatus,
      })
    } catch (error) {
      console.error("Reminder send failure:", error)
      await markReminderStatus(submission.id, false, "Unexpected reminder dispatch error")
      outcomes.push({
        submissionId: submission.id,
        success: false,
        message: "Unexpected reminder dispatch error",
      })
    }
  }

  return {
    success: true,
    checkedWindowStart: start.toISOString(),
    checkedWindowEnd: end.toISOString(),
    totalEligible: targets.length,
    sent: outcomes.filter((item) => item.success).length,
    failed: outcomes.filter((item) => !item.success).length,
    outcomes,
  }
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const result = await runReminderDispatch()
    return NextResponse.json(result)
  } catch (error) {
    console.error("Reminder run failed:", error)
    return NextResponse.json({ error: "Reminder run failed" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
