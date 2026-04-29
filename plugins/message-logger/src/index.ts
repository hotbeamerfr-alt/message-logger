import { findByName, findByProps } from "@vendetta/metro";
import { FluxDispatcher, ReactNative } from "@vendetta/metro/common";
import { after, before, instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";

const patches: any[] = [];
const ChannelMessages    = findByProps("_channelMessages");
const MessageRecordUtils = findByProps("updateMessageRecord", "createMessageRecord");
const MessageRecord      = findByName("MessageRecord", false);
const RowManager         = findByName("RowManager");

// Lazy-loaded so it doesn't crash on init if unavailable
function getFileModule() {
  try {
    return (
      ReactNative.NativeModules.DCDFileManager ??
      findByProps("writeFile", "readFile", "getConstants") ??
      null
    );
  } catch {
    return null;
  }
}

// Safe storage init
if (!storage.nopk) storage.nopk = false;
if (!storage.deletedMessages) storage.deletedMessages = {};

// ── Media helpers ────────────────────────────────────────────────────────────

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes  = new Uint8Array(buffer);
  let   binary = "";
  const CHUNK  = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK)
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

async function downloadMedia(url: string, filename: string, messageId: string): Promise<string | null> {
  try {
    const fm = getFileModule();
    if (!fm) return null;

    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > 50 * 1024 * 1024) return null;

    const base64   = arrayBufferToBase64(buffer);
    const saveName = ("vml_" + messageId + "_" + filename).replace(/[^a-zA-Z0-9._\-]/g, "_");

    await fm.writeFile("documents", saveName, base64, "base64");

    const consts = fm.getConstants?.() ?? fm.getConstants;
    const docDir = consts?.DocumentDirectory ?? "";
    return docDir ? ("file://" + docDir + "/" + saveName) : null;
  } catch {
    return null;
  }
}

async function downloadAllMedia(msgJS: any, messageId: string, channelId: string): Promise<void> {
  try {
    const items: { url: string; filename: string; mimeType: string }[] = [];

    for (const att of (msgJS.attachments ?? [])) {
      const url = att.url ?? att.proxy_url;
      if (url) items.push({ url, filename: att.filename ?? att.id, mimeType: att.content_type ?? "" });
    }

    for (const embed of (msgJS.embeds ?? [])) {
      const imgUrl   = embed.image?.proxy_url   ?? embed.image?.url;
      const vidUrl   = embed.video?.proxy_url   ?? embed.video?.url;
      const thumbUrl = embed.thumbnail?.proxy_url ?? embed.thumbnail?.url;
      const key      = String(embed.url ?? Date.now());

      if (imgUrl)   items.push({ url: imgUrl,   filename: "embed_img_"   + key, mimeType: "image/jpeg" });
      if (vidUrl)   items.push({ url: vidUrl,   filename: "embed_vid_"   + key, mimeType: "video/mp4"  });
      if (thumbUrl) items.push({ url: thumbUrl, filename: "embed_thumb_" + key, mimeType: "image/jpeg" });
    }

    if (items.length === 0) return;

    const localAttachments: object[] = [];
    for (const { url, filename, mimeType } of items) {
      const localPath = await downloadMedia(url, filename, messageId);
      localAttachments.push({ filename, localPath, originalUrl: url, mimeType });
    }

    if (storage.deletedMessages[channelId]?.[messageId])
      storage.deletedMessages[channelId][messageId].localAttachments = localAttachments;
  } catch {}
}

// ── Persistence ──────────────────────────────────────────────────────────────

function saveDeletedMessage(message: any) {
  try {
    const cid = message.channel_id;
    const mid = message.id;

    if (!storage.deletedMessages[cid]) storage.deletedMessages[cid] = {};
    storage.deletedMessages[cid][mid] = {
      ...message.toJS(),
      __vml_deleted:    true,
      __vml_savedAt:    Date.now(),
      localAttachments: [],
    };

    downloadAllMedia(message.toJS(), mid, cid).catch(() => {});
  } catch {}
}

function removeDeletedMessage(channelId: string, messageId: string) {
  try {
    if (!storage.deletedMessages[channelId]) return;
    delete storage.deletedMessages[channelId][messageId];
    if (Object.keys(storage.deletedMessages[channelId]).length === 0)
      delete storage.deletedMessages[channelId];
  } catch {}
}

function restoreDeletedMessages(channelId: string) {
  try {
    const saved = storage.deletedMessages[channelId];
    if (!saved) return;

    const channel = ChannelMessages.get(channelId);
    for (const [messageId, msgData] of Object.entries(saved) as [string, any][]) {
      if (channel?.get(messageId)) continue;
      FluxDispatcher.dispatch({
        type:               "MESSAGE_CREATE",
        channelId,
        message:            { ...msgData, __vml_deleted: true },
        optimistic:         false,
        isPushNotification: false,
      });
    }
  } catch {}
}

// ── Patches ──────────────────────────────────────────────────────────────────

patches.push(before("dispatch", FluxDispatcher, ([event]) => {
  try {
    if (event.type === "LOAD_MESSAGES_SUCCESS") {
      setTimeout(() => restoreDeletedMessages(event.channelId), 100);
      return;
    }

    if (event.type === "MESSAGE_DELETE") {
      if (event.__vml_cleanup) return event;

      const channel = ChannelMessages.get(event.channelId);
      const message = channel?.get(event.id);
      if (!message) return event;

      if (message.author?.id === "1")       return event;
      if (message.state  === "SEND_FAILED") return event;

      saveDeletedMessage(message);

      if (storage.nopk) {
        fetch("https://api.pluralkit.me/v2/messages/" + encodeURIComponent(message.id))
          .then((res) => res.json())
          .then((data) => {
            if (message.id === data.original && !data.member?.keep_proxy) {
              removeDeletedMessage(message.channel_id, message.id);
              FluxDispatcher.dispatch({
                type:          "MESSAGE_DELETE",
                id:            message.id,
                channelId:     message.channel_id,
                __vml_cleanup: true,
              });
            }
          }).catch(() => {});
      }

      return [{
        message: { ...message.toJS(), __vml_deleted: true },
        type:    "MESSAGE_UPDATE",
      }];
    }
  } catch {}
}));

patches.push(after("generate", RowManager.prototype, ([data], row) => {
  try {
    if (data.rowType !== 1) return;
    if (data.message.__vml_deleted) {
      row.message.edited = "deleted";
      row.backgroundHighlight = row.backgroundHighlight ?? {};
      row.backgroundHighlight.backgroundColor = ReactNative.processColor("#da373c22");
      row.backgroundHighlight.gutterColor     = ReactNative.processColor("#da373cff");
    }
  } catch {}
}));

patches.push(instead("updateMessageRecord", MessageRecordUtils, function ([oldRecord, newRecord], orig) {
  try {
    if (newRecord.__vml_deleted)
      return MessageRecordUtils.createMessageRecord(newRecord, oldRecord.reactions);
  } catch {}
  return orig.apply(this, [oldRecord, newRecord]);
}));

patches.push(after("createMessageRecord", MessageRecordUtils, function ([message], record) {
  try { record.__vml_deleted = message.__vml_deleted; } catch {}
}));

patches.push(after("default", MessageRecord, ([props], record) => {
  try { record.__vml_deleted = !!props.__vml_deleted; } catch {}
}));

// ── Unload ───────────────────────────────────────────────────────────────────

export const onUnload = () => {
  patches.forEach((unpatch) => { try { unpatch(); } catch {} });

  try {
    for (const channelId in ChannelMessages._channelMessages) {
      for (const message of ChannelMessages._channelMessages[channelId]._array) {
        if (message.__vml_deleted) {
          FluxDispatcher.dispatch({
            type:          "MESSAGE_DELETE",
            id:            message.id,
            channelId:     message.channel_id,
            __vml_cleanup: true,
          });
        }
      }
    }
  } catch {}
};

export { default as settings } from "./settings";
