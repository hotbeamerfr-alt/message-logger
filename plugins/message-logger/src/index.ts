import { findByName, findByProps } from "@vendetta/metro";
import { FluxDispatcher, ReactNative } from "@vendetta/metro/common";
import { after, before, instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";

const patches = [];

const ChannelMessages = findByProps("_channelMessages");
const MessageRecordUtils = findByProps("updateMessageRecord", "createMessageRecord");
const MessageRecord = findByName("MessageRecord", false);
const RowManager = findByName("RowManager");

// init storage
storage.nopk ??= false;
storage.logs ??= {};

// helper: clean message (NO cursed objects)
function cleanMessage(message) {
  return {
    id: message.id,
    channel_id: message.channel_id,
    content: message.content,
    author: {
      id: message.author?.id,
      username: message.author?.username,
      avatar: message.author?.avatar
    },
    timestamp: message.timestamp,
    edited_timestamp: message.edited_timestamp ?? null,
    attachments: message.attachments ?? [],
    embeds: message.embeds ?? [],
  };
}

// helper: limit storage (avoid lag explosion)
function trimLogs(cid) {
  const MAX = 100;
  const keys = Object.keys(storage.logs[cid] || {});
  if (keys.length > MAX) {
    delete storage.logs[cid][keys[0]];
  }
}

// MAIN PATCH
patches.push(before("dispatch", FluxDispatcher, ([event]) => {

  // 🔁 restore on load
  if (event.type === "LOAD_MESSAGES_SUCCESS") {
    const saved = storage.logs[event.channelId];
    if (!saved) return;

    const channel = ChannelMessages.get(event.channelId);

    setTimeout(() => {
      for (const [id, msg] of Object.entries(saved)) {
        if (channel?.get(id)) continue;

        FluxDispatcher.dispatch({
          type: "MESSAGE_CREATE",
          channelId: event.channelId,
          message: {
            ...msg,
            __vml_deleted: true,
            state: "SENT"
          },
          optimistic: false,
          isPushNotification: false,
        });
      }
    }, 100);
    return;
  }

  // 🗑️ capture deletes
  if (event.type === "MESSAGE_DELETE") {
    if (event.__vml_cleanup) return event;

    const channel = ChannelMessages.get(event.channelId);
    const message = channel?.get(event.id);
    if (!message) return event;

    if (message.author?.id == "1") return event;
    if (message.state == "SEND_FAILED") return event;

    const cid = message.channel_id;
    const mid = message.id;

    storage.logs[cid] ??= {};

    const clean = cleanMessage(message);
    storage.logs[cid][mid] = {
      ...clean,
      __vml_deleted: true
    };

    trimLogs(cid);

    // optional pluralkit filter
    if (storage.nopk) {
      fetch(`https://api.pluralkit.me/v2/messages/${encodeURIComponent(message.id)}`)
        .then(res => res.json())
        .then(data => {
          if (message.id === data.original && !data.member?.keep_proxy) {
            delete storage.logs[cid]?.[mid];

            FluxDispatcher.dispatch({
              type: "MESSAGE_DELETE",
              id: message.id,
              channelId: message.channel_id,
              __vml_cleanup: true,
            });
          }
        })
        .catch(() => {});
    }

    return [{
      message: {
        ...clean,
        __vml_deleted: true,
      },
      type: "MESSAGE_UPDATE",
    }];
  }
}));

// highlight deleted messages
patches.push(after("generate", RowManager.prototype, ([data], row) => {
  if (data.rowType !== 1) return;

  if (data.message.__vml_deleted) {
    row.message.edited = "deleted";

    row.backgroundHighlight ??= {};
    row.backgroundHighlight.backgroundColor = ReactNative.processColor("#da373c22");
    row.backgroundHighlight.gutterColor = ReactNative.processColor("#da373cff");
  }
}));

// fix record updates
patches.push(instead("updateMessageRecord", MessageRecordUtils, function ([oldRecord, newRecord], orig) {
  if (newRecord.__vml_deleted) {
    return MessageRecordUtils.createMessageRecord(newRecord, oldRecord.reactions);
  }
  return orig.apply(this, [oldRecord, newRecord]);
}));

patches.push(after("createMessageRecord", MessageRecordUtils, function ([message], record) {
  record.__vml_deleted = message.__vml_deleted;
}));

patches.push(after("default", MessageRecord, ([props], record) => {
  record.__vml_deleted = !!props.__vml_deleted;
}));

// cleanup
export const onUnload = () => {
  patches.forEach(unpatch => unpatch());

  for (const channelId in ChannelMessages._channelMessages) {
    for (const message of ChannelMessages._channelMessages[channelId]._array) {
      if (message.__vml_deleted) {
        FluxDispatcher.dispatch({
          type: "MESSAGE_DELETE",
          id: message.id,
          channelId: message.channel_id,
          __vml_cleanup: true,
        });
      }
    }
  }
};

export { default as settings } from "./settings";
