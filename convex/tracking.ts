import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

const emailArgs = {
  trackingId: v.string(),
  subject: v.string(),
  sender: v.string(),
  recipients: v.array(v.string()),
  gmailThreadId: v.union(v.string(), v.null()),
  gmailMessageId: v.union(v.string(), v.null()),
  sentAt: v.string(),
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
      sentAt: args.sentAt,
      firstOpenedAt: null,
      lastOpenedAt: null,
      openCount: 0,
      firstClickedAt: null,
      lastClickedAt: null,
      clickCount: 0,
      createdAt: args.sentAt,
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
    return await ctx.db
      .query("trackedEmails")
      .withIndex("by_trackingId", (q) => q.eq("trackingId", args.trackingId))
      .unique();
  },
});

export const listEmails = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db.query("trackedEmails").withIndex("by_sentAt").order("desc").take(args.limit);
  },
});

export const patchEmail = internalMutation({
  args: {
    trackingId: v.string(),
    gmailThreadId: v.optional(v.union(v.string(), v.null())),
    gmailMessageId: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("trackedEmails")
      .withIndex("by_trackingId", (q) => q.eq("trackingId", args.trackingId))
      .unique();
    if (!row) return null;
    const patch: { gmailThreadId?: string | null; gmailMessageId?: string | null } = {};
    if (args.gmailThreadId !== undefined) patch.gmailThreadId = args.gmailThreadId;
    if (args.gmailMessageId !== undefined) patch.gmailMessageId = args.gmailMessageId;
    if (Object.keys(patch).length) await ctx.db.patch(row._id, patch);
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
    return await ctx.db.query("trackingEvents").withIndex("by_timestamp").order("desc").take(50);
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
  clickId: v.union(v.string(), v.null()),
  destination: v.union(v.string(), v.null()),
};

export const recordOpen = internalMutation({
  args: eventArgs,
  handler: async (ctx, args) => {
    const email = await ctx.db
      .query("trackedEmails")
      .withIndex("by_trackingId", (q) => q.eq("trackingId", args.trackingId))
      .unique();
    if (!email) return;
    await ctx.db.insert("trackingEvents", args);
    const openCount = email.openCount + 1;
    await ctx.db.patch(email._id, {
      openCount,
      lastOpenedAt: args.timestamp,
      firstOpenedAt: openCount === 1 ? args.timestamp : email.firstOpenedAt,
    });
  },
});

export const recordClick = internalMutation({
  args: eventArgs,
  handler: async (ctx, args) => {
    const email = await ctx.db
      .query("trackedEmails")
      .withIndex("by_trackingId", (q) => q.eq("trackingId", args.trackingId))
      .unique();
    await ctx.db.insert("trackingEvents", args);
    if (!email) return;
    const clickCount = email.clickCount + 1;
    await ctx.db.patch(email._id, {
      clickCount,
      lastClickedAt: args.timestamp,
      firstClickedAt: clickCount === 1 ? args.timestamp : email.firstClickedAt,
    });
  },
});
