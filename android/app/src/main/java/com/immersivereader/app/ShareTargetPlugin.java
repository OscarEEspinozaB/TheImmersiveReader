package com.immersivereader.app;

import android.content.Intent;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * "Share → The Immersive Reader": receives text (an assistant's answer, an article's
 * link) shared from any other app and hands it to the web layer (src/shareTarget.js)
 * as a "shared" event — { text, subject? }.
 *
 * The manifest declares the ACTION_SEND text/plain intent filter. BridgeActivity
 * forwards both the launch intent (cold start) and later ones (the app is singleTask,
 * so a share while it runs arrives as a new intent) to handleOnNewIntent. The event
 * is RETAINED until the web layer listens, so a share that cold-starts the app is not
 * lost while the page is still booting.
 */
@CapacitorPlugin(name = "ShareTarget")
public class ShareTargetPlugin extends Plugin {

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        JSObject share = read(intent);
        if (share == null) return;
        // Consumed: an activity re-creation (rotation, theme) must not deliver it again.
        intent.setAction(Intent.ACTION_MAIN);
        intent.removeExtra(Intent.EXTRA_TEXT);
        intent.removeExtra(Intent.EXTRA_SUBJECT);
        notifyListeners("shared", share, true);
    }

    private static JSObject read(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return null;
        String type = intent.getType();
        if (type == null || !type.startsWith("text/")) return null;
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (text == null || text.toString().trim().isEmpty()) return null;
        JSObject share = new JSObject();
        share.put("text", text.toString());
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        if (subject != null && !subject.trim().isEmpty()) share.put("subject", subject);
        return share;
    }
}
