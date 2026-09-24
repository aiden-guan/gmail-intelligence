import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

const emailArgs = {
  trackingId: v.string(),
  subject: v.string(),
  sender: v.string(),
  recipients: v.array(v.string()),
  gmailThreadId: v.union(v.string(), v.null()),
  gmailMessageId: v.union(v.string(), v.null()),
  status: v.optional(v.union(v.literal("PENDING"), v.literal("SENT"), v.literal("CANCELLED"), v.literal("FAILED"))),
  sentAt: v.union(v.string(), v.null()),
  createdAt: v.string(),
  links: v.array(v.object({ clickId: v.string(), destination: v.string() })),
};

export const createEmail = internalMutation({
  args: emailArgs,
  handler: async (ctx, args) => {
    await ctx.db.insert("trackedEmails", {
      trackingId: args.trackingId,
      subject: args.subject,
      sender: args.sender,
      recipients: args.recipients,
      gmailThreadId: args.gmailThreadId,
      gmailMessageId: args.gmailMessageId,
      status: args.status || (args.sentAt ? "SENT" : "PENDING"),
      sentAt: args.sentAt,
      firstOpenedAt: null,
      lastOpenedAt: null,
      openCount: 0,
      firstClickedAt: null,
      lastClickedAt: null,
      clickCount: 0,
      createdAt: args.createdAt,
    });
    for (const link of args.links) {
      await ctx.db.insert("trackedLinks", {
        clickId: link.clickId,
        trackingId: args.trackingId,
        destination: link.destination,
      });
    }
  },
});

export const getEmail = internalQuery({
  args: { trackingId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("trackedEmails")
      .withIndex("by_trackingId", (q) => q.eq("trackingId", args.trackingId))
      .take(5);
    return rows.sort((a, b) => b.openCount - a.openCount)[0] ?? null;
  },
});

export const listEmails = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db.query("trackedEmails").order("desc").take(args.limit);
  },
});

export const patchEmail = internalMutation({
  args: {
    trackingId: v.string(),
    gmailThreadId: v.optional(v.union(v.string(), v.null())),
    gmailMessageId: v.optional(v.union(v.string(), v.null())),
    status: v.optional(v.union(v.literal("PENDING"), v.literal("SENT"), v.literal("CANCELLED"), v.literal("FAILED"))),
    sentAt: v.optional(v.union(v.string(), v.null())),
    subject: v.optional(v.string()),
    sender: v.optional(v.string()),
    recipients: v.optional(v.array(v.string())),
    links: v.optional(v.array(v.object({ clickId: v.string(), destination: v.string() }))),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("trackedEmails")
      .withIndex("by_trackingId", (q) => q.eq("trackingId", args.trackingId))
      .take(1);
    const row = rows[0];
    if (!row) return null;
    const patch: {
      gmailThreadId?: string | null;
      gmailMessageId?: string | null;
      status?: "PENDING" | "SENT" | "CANCELLED" | "FAILED";
      sentAt?: string | null;
      subject?: string;
      sender?: string;
      recipients?: string[];
    } = {};
    if (args.gmailThreadId !== undefined) patch.gmailThreadId = args.gmailThreadId;
    if (args.gmailMessageId !== undefined) patch.gmailMessageId = args.gmailMessageId;
    if (args.status !== undefined) patch.status = args.status;
    if (args.sentAt !== undefined) patch.sentAt = args.sentAt;
    if (args.subject !== undefined) patch.subject = args.subject;
    if (args.sender !== undefined) patch.sender = args.sender;
    if (args.recipients !== undefined) patch.recipients = args.recipients;
    if (patch.status === "SENT" && patch.sentAt === undefined && !row.sentAt) {
      patch.sentAt = new Date().toISOString();
    }
    if (Object.keys(patch).length) await ctx.db.patch(row._id, patch);
    for (const link of args.links || []) {
      const existing = await ctx.db
        .query("trackedLinks")
        .withIndex("by_clickId", (q) => q.eq("clickId", link.clickId))
        .unique();
      if (!existing) {
        await ctx.db.insert("trackedLinks", {
          clickId: link.clickId,
          trackingId: args.trackingId,
          destination: link.destination,
        });
      }
    }
    return await ctx.db.get(row._id);
  },
});

export const listEvents = internalQuery({
  args: { trackingId: v.string() },
  handler: async (ctx, args) => {
    const events = await ctx.db
      .query("trackingEvents")
      .withIndex("by_trackingId", (q) => q.eq("trackingId", args.trackingId))
      .take(200);
    return events.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  },
});

export const recentEvents = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("trackingEvents").order("desc").take(50);
  },
});

export const getLink = internalQuery({
  args: { clickId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("trackedLinks")
      .withIndex("by_clickId", (q) => q.eq("clickId", args.clickId))
      .unique();
  },
});

const eventArgs = {
  eventId: v.string(),
  trackingId: v.string(),
  type: v.union(v.literal("OPEN"), v.literal("CLICK")),
  timestamp: v.string(),
  userAgent: v.union(v.string(), v.null()),
  ipHash: v.union(v.string(), v.null()),
  suspectedSelfOpen: v.boolean(),
  confidence: v.number(),
  classification: v.optional(v.union(v.literal("RECIPIENT_LIKELY"), v.literal("SELF_LIKELY"), v.literal("UNKNOWN"))),
  clickId: v.union(v.string(), v.null()),
  destination: v.union(v.string(), v.null()),
};

export const recordOpen = internalMutation({
  args: eventArgs,
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("trackedEmails")
      .withIndex("by_trackingId", (q) => q.eq("trackingId", args.trackingId))
      .take(1);
    const email = rows[0];
    if (!email) return { recorded: false };
    const nowMs = Date.parse(args.timestamp);
    const lastMs = email.lastOpenedAt ? Date.parse(email.lastOpenedAt) : 0;
    // Gmail's image proxy often sends the same pixel twice back to back.
    if (lastMs && Number.isFinite(nowMs) && nowMs >= lastMs && nowMs - lastMs < 800) return { recorded: false };
    const openCount = email.openCount + 1;
    await ctx.db.patch(email._id, {
      openCount,
      lastOpenedAt: args.timestamp,
      firstOpenedAt: email.openCount === 0 ? args.timestamp : email.firstOpenedAt,
    });
    return { recorded: true };
  },
});

export const recordOpenEvent = internalMutation({
  args: eventArgs,
  handler: async (ctx, args) => {
    await ctx.db.insert("trackingEvents", {
      eventId: args.eventId,
      trackingId: args.trackingId,
      type: args.type,
      timestamp: args.timestamp,
      userAgent: args.userAgent,
      ipHash: args.ipHash,
      suspectedSelfOpen: args.suspectedSelfOpen,
      confidence: args.confidence,
      classification: args.classification || "UNKNOWN",
      clickId: args.clickId,
      destination: args.destination,
    });
  },
});

export const recordClick = internalMutation({
  args: eventArgs,
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("trackedEmails")
      .withIndex("by_trackingId", (q) => q.eq("trackingId", args.trackingId))
      .take(1);
    const email = rows[0];
    await ctx.db.insert("trackingEvents", {
      eventId: args.eventId,
      trackingId: args.trackingId,
      type: args.type,
      timestamp: args.timestamp,
      userAgent: args.userAgent,
      ipHash: args.ipHash,
      suspectedSelfOpen: args.suspectedSelfOpen,
      confidence: args.confidence,
      classification: args.classification || "UNKNOWN",
      clickId: args.clickId,
      destination: args.destination,
    });
    if (!email) return;
    const clickCount = email.clickCount + 1;
    await ctx.db.patch(email._id, {
      clickCount,
      lastClickedAt: args.timestamp,
      firstClickedAt: clickCount === 1 ? args.timestamp : email.firstClickedAt,
    });
  },
});
