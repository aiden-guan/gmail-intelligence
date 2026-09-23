import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  trackedEmails: defineTable({
    trackingId: v.string(),
    subject: v.string(),
    sender: v.string(),
    recipients: v.array(v.string()),
    gmailThreadId: v.union(v.string(), v.null()),
    gmailMessageId: v.union(v.string(), v.null()),
    sentAt: v.string(),
    firstOpenedAt: v.union(v.string(), v.null()),
    lastOpenedAt: v.union(v.string(), v.null()),
    openCount: v.number(),
    firstClickedAt: v.union(v.string(), v.null()),
    lastClickedAt: v.union(v.string(), v.null()),
    clickCount: v.number(),
    createdAt: v.string(),
  })
    .index("by_trackingId", ["trackingId"])
    .index("by_sentAt", ["sentAt"]),
  trackedLinks: defineTable({
    clickId: v.string(),
    trackingId: v.string(),
    destination: v.string(),
  }).index("by_clickId", ["clickId"]),
  trackingEvents: defineTable({
    eventId: v.string(),
    trackingId: v.string(),
    type: v.union(v.literal("OPEN"), v.literal("CLICK")),
    timestamp: v.string(),
    userAgent: v.union(v.string(), v.null()),
    ipHash: v.union(v.string(), v.null()),
    suspectedSelfOpen: v.boolean(),
    confidence: v.number(),
    clickId: v.union(v.string(), v.null()),
    destination: v.union(v.string(), v.null()),
  })
    .index("by_trackingId", ["trackingId"])
    .index("by_timestamp", ["timestamp"]),
});
