package com.immersivereader.app;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;

import androidx.core.view.WindowCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Full edge-to-edge. The @capacitor/status-bar plugin only overlays the TOP
        // (status) bar; this lays the WebView out behind BOTH system bars, so the
        // bottom navigation bar is edge-to-edge too. The CSS reserves the space via
        // env(safe-area-inset-*) (--sat/--sab), which only become non-zero once the
        // window stops fitting the system windows.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        // Disable the translucent contrast scrim (API 29+) so the bar is truly
        // transparent; the gesture pill adapts its own color automatically.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getWindow().setNavigationBarContrastEnforced(false);
        }
    }
}
