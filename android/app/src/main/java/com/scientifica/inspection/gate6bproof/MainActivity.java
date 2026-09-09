package com.scientifica.inspection.gate6bproof;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(Gate6BCompetingWriterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
