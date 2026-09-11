package com.scientifica.inspection.gate6bproof;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Intent;
import android.os.Build;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class Gate6CGalleryPickerInstrumentedTest {
    @Test
    public void galleryPickerIntentUsesOpenDocumentSingleMediaReadOnlyContract() {
        Intent intent = Gate6CEvidencePlugin.buildGalleryMediaIntent();
        assertEquals(Intent.ACTION_OPEN_DOCUMENT, intent.getAction());
        assertTrue(intent.hasCategory(Intent.CATEGORY_OPENABLE));
        assertEquals("*/*", intent.getType());
        assertFalse(intent.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, true));
        assertArrayEquals(new String[]{ "image/*", "video/*" }, intent.getStringArrayExtra(Intent.EXTRA_MIME_TYPES));
        assertTrue((intent.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0);
        assertEquals(0, intent.getFlags() & Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        assertEquals(0, intent.getFlags() & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        System.out.println("GATE6CD_GALLERY_PICKER_INTENT_PASS api=" + Build.VERSION.SDK_INT);
    }
}
