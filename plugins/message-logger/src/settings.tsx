import { ReactNative } from "@vendetta/metro/common";
import { findByProps } from "@vendetta/metro";
import { Forms } from "@vendetta/ui/components";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { showToast } from "@vendetta/ui/toasts";

const { FormIcon, FormSwitchRow, FormRow, FormSection, FormDivider, FormText } = Forms;
const { Alert, ScrollView } = ReactNative;

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

if (!storage.nopk) storage.nopk = false;
if (!storage.deletedMessages) storage.deletedMessages = {};

export default () => {
  useProxy(storage);

  const logs = (storage.deletedMessages ?? {}) as Record<string, Record<string, any>>;

  let totalMsgs  = 0;
  let totalMedia = 0;

  try {
    for (const cid of Object.keys(logs)) {
      for (const entry of Object.values(logs[cid])) {
        totalMsgs++;
        totalMedia += (entry.localAttachments ?? []).filter((a: any) => a.localPath).length;
      }
    }
  } catch {}

  const channelCount = Object.keys(logs).length;

  const clearAll = async () => {
    try {
      const fm = getFileModule();
      if (fm) {
        for (const cid of Object.keys(logs)) {
          for (const entry of Object.values(logs[cid])) {
            for (const att of (entry.localAttachments ?? [])) {
              if (!att.localPath) continue;
              try {
                const filename = att.localPath.split("/").pop();
                if (filename) await fm.deleteFile("documents", filename);
              } catch {}
            }
          }
        }
      }
    } catch {}

    storage.deletedMessages = {};
    showToast("Cleared all saved messages and media", getAssetIDByName("ic_trash"));
  };

  const confirmClear = () => {
    if (totalMsgs === 0) return;
    Alert.alert(
      "Clear all saved messages?",
      "This will permanently delete " + totalMsgs + " message" + (totalMsgs !== 1 ? "s" : "") +
      " and " + totalMedia + " media file" + (totalMedia !== 1 ? "s" : "") + " from your device. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Clear All", style: "destructive", onPress: clearAll },
      ]
    );
  };

  return (
    <ScrollView>
      <FormSection title="FILTERS">
        <FormSwitchRow
          label="Ignore PluralKit"
          subLabel="Don't log messages deleted by PluralKit proxying"
          leading={<FormIcon source={getAssetIDByName("ic_block")} />}
          onValueChange={(v: boolean) => { storage.nopk = v; }}
          value={storage.nopk}
        />
      </FormSection>

      <FormSection title="PERSISTENT LOG">
        <FormRow
          label="Saved Messages"
          subLabel={
            totalMsgs === 0
              ? "No messages saved yet"
              : totalMsgs + " message" + (totalMsgs !== 1 ? "s" : "") + " across " + channelCount + " channel" + (channelCount !== 1 ? "s" : "")
          }
          leading={<FormIcon source={getAssetIDByName("ic_message")} />}
        />
        <FormDivider />
        <FormRow
          label="Saved Media Files"
          subLabel={
            totalMedia === 0
              ? "No media downloaded yet"
              : totalMedia + " file" + (totalMedia !== 1 ? "s" : "") + " saved locally on your device"
          }
          leading={<FormIcon source={getAssetIDByName("ic_image")} />}
        />
        <FormDivider />
        <FormRow
          label="Clear All Saved Messages & Media"
          subLabel={
            totalMsgs === 0
              ? "Nothing to clear"
              : "Deletes all logs and removes media files from device"
          }
          leading={<FormIcon source={getAssetIDByName("ic_trash")} />}
          onPress={confirmClear}
        />
      </FormSection>

      <FormSection title="HOW IT WORKS">
        <FormText style={{ paddingHorizontal: 16, paddingVertical: 12, opacity: 0.7 }}>
          When a message is deleted, it is saved to disk and media is downloaded locally before Discord's CDN removes it. Messages are restored each time you open that channel. Tap Clear All to wipe everything.
        </FormText>
      </FormSection>
    </ScrollView>
  );
};
