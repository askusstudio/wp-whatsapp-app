import type { DeliveryStatus, SendMessageResponse } from "@/types"
import { normalizePhoneNumber } from "@/lib/phone"

interface SendOptions {
  templateName?: string
  templateLanguage?: string
  components?: unknown[]
}

function buildBodyComponents(params: Array<string | undefined | null>) {
  const texts = params.map((value) => (value || "").toString().trim())
  return [
    {
      type: "body",
      parameters: texts.map((text) => ({ type: "text", text })),
    },
  ]
}

function trimTrailingSlash(input: string) {
  return input.replace(/\/+$/, "")
}

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(value)
}

function getMessagesEndpoint() {
  const explicitEndpoint = (process.env.WHATSAPP_MESSAGES_ENDPOINT || "").trim()
  if (explicitEndpoint && isHttpUrl(explicitEndpoint)) {
    return explicitEndpoint
  }

  const base = process.env.WHATSAPP_API_URL
  if (!base) {
    return ""
  }

  if (base.includes("/messages")) {
    return base
  }

  const trimmedBase = trimTrailingSlash(base)
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID

  if (phoneNumberId) {
    return `${trimmedBase}/${phoneNumberId}/messages`
  }

  return `${trimmedBase}/messages`
}

function normalizeApiStatus(status: unknown): DeliveryStatus {
  if (typeof status !== "string") {
    return "unknown"
  }

  const normalized = status.toLowerCase()

  if (normalized === "accepted") return "accepted"
  if (normalized === "delivered") return "delivered"
  if (normalized === "read") return "read"
  if (normalized === "failed") return "failed"
  if (normalized === "sent") return "accepted"
  if (normalized === "held_for_quality_assessment") return "held_for_quality_assessment"

  return "unknown"
}

export async function sendWhatsAppText(phone: string, message: string): Promise<SendMessageResponse> {
  return sendWhatsAppMessage(phone, message)
}

export async function sendWelcomeWhatsApp(
  phone: string,
  fallbackMessage: string,
  variables?: { name?: string; event?: string; city?: string },
) {
  return sendWhatsAppMessage(phone, fallbackMessage, {
    templateName: process.env.WHATSAPP_WELCOME_TEMPLATE_NAME,
    templateLanguage: process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en",
    components: buildBodyComponents([variables?.name, variables?.event, variables?.city]),
  })
}

export async function sendReminderWhatsApp(
  phone: string,
  fallbackMessage: string,
  variables?: { name?: string; event?: string; city?: string; schedule?: string },
) {
  return sendWhatsAppMessage(phone, fallbackMessage, {
    templateName: process.env.WHATSAPP_REMINDER_TEMPLATE_NAME,
    templateLanguage: process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en",
    components: buildBodyComponents([variables?.name, variables?.event, variables?.city]),
  })
}

export async function sendTemplateWhatsApp(
  phone: string,
  templateName: string,
  fallbackMessage: string,
  variables?: Array<string | undefined | null>,
) {
  return sendWhatsAppMessage(phone, fallbackMessage, {
    templateName,
    templateLanguage: process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en",
    components: variables && variables.length > 0 ? buildBodyComponents(variables) : undefined,
  })
}

async function sendWhatsAppMessage(phone: string, message: string, options?: SendOptions): Promise<SendMessageResponse> {
  if (!phone || !message) {
    return {
      success: false,
      message: "Phone and message are required",
      recipient: phone,
      deliveryStatus: "failed",
    }
  }

  const waPhone = normalizePhoneNumber(phone)
  const whatsappToken = process.env.WHATSAPP_ACCESS_TOKEN
  const endpoint = getMessagesEndpoint()

  if (endpoint && whatsappToken) {
    try {
      const payload = options?.templateName
        ? {
            messaging_product: "whatsapp",
            to: waPhone,
            type: "template",
            template: {
              name: options.templateName,
              language: {
                code: options.templateLanguage || "en",
              },
              ...(options.components && options.components.length > 0
                ? { components: options.components }
                : {}),
            },
          }
        : {
            messaging_product: "whatsapp",
            to: waPhone,
            type: "text",
            text: { body: message },
          }

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${whatsappToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      })

      const data = await response.json()

      if (!response.ok || data?.error) {
        return {
          success: false,
          message: data?.error?.message || "Failed to send message",
          recipient: phone,
          deliveryStatus: "failed",
        }
      }

      const messageId = Array.isArray(data?.messages) ? data.messages[0]?.id : undefined
      const deliveryStatus = normalizeApiStatus(
        Array.isArray(data?.messages) ? data.messages[0]?.message_status : "accepted",
      )
      const responseMessage =
        deliveryStatus === "held_for_quality_assessment"
          ? "Message held for quality assessment"
          : deliveryStatus === "accepted"
            ? "Message accepted by WhatsApp (delivery pending)"
            : "Message accepted by WhatsApp"

      return {
        success: true,
        message: responseMessage,
        recipient: phone,
        messageId,
        deliveryStatus,
      }
    } catch (error) {
      console.error("WhatsApp API error:", error)
      return {
        success: false,
        message: "Failed to send WhatsApp message",
        recipient: phone,
        deliveryStatus: "failed",
      }
    }
  }

  const waLink = `https://wa.me/${waPhone}?text=${encodeURIComponent(message)}`

  return {
    success: true,
    message: "WhatsApp link generated",
    waLink,
    recipient: phone,
    deliveryStatus: "accepted",
  }
}
