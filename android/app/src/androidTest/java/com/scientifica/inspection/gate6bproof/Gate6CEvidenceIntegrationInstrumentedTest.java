package com.scientifica.inspection.gate6bproof;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import androidx.core.content.FileProvider;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class Gate6CEvidenceIntegrationInstrumentedTest {
    private static final long SOURCE_BYTES = 512L * 1024L + 137L;

    @Test
    public void closedEvidenceOrchestrationConsumesAndroidAdaptersAndSurvivesReopen() throws Exception {
        final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        final File source = syntheticSource(context, "gate6c-integration-source.bin", SOURCE_BYTES);
        final String expectedHash = hash(source);
        final Uri sourceUri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", source);

        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            waitForProofFunction(scenario);
            final String invoke =
                "window.__gate6cIntegrationResult=null;" +
                "window.__gate6cRunIntegrationProof(" + JSONObject.quote(sourceUri.toString()) + "," + source.length() + "," + JSONObject.quote(expectedHash) + ")" +
                ".then(function(r){window.__gate6cIntegrationResult=JSON.stringify(r);})" +
                ".catch(function(e){window.__gate6cIntegrationResult=JSON.stringify({status:'FAIL',error:String(e&&(e.stack||e.message)||e)});});" +
                "'STARTED';";
            assertEquals("STARTED", decodeJsValue(evaluate(scenario, invoke)));

            final JSONObject result = new JSONObject(waitForProofResult(scenario));
            assertEquals("PASS", result.getString("status"));
            assertTrue(result.getBoolean("sourceIsContentUri"));
            assertTrue(result.getBoolean("canonicalStorageRef"));
            assertTrue(result.getBoolean("canonicalHash"));
            assertEquals(source.length(), result.getLong("expectedSize"));
            assertEquals(source.length(), result.getLong("persistedSize"));
            assertEquals(expectedHash, result.getString("expectedHash"));
            assertEquals(expectedHash, result.getString("persistedHash"));
            assertTrue(result.getBoolean("sizeHintIgnored"));
            assertTrue(result.getBoolean("publishCompletedBeforeDbBegin"));
            assertTrue(result.getBoolean("publishCompletedBeforeEvidenceInsert"));
            assertTrue(result.getBoolean("transactionCommitted"));
            assertTrue(result.getBoolean("reconciliationValidAfterReopen"));
            assertEquals("MATCH", result.getString("hashStatusAfterReopen"));
            assertTrue(result.getBoolean("reopenedMetadataMatches"));
            assertTrue(result.getString("resolvedHandle").startsWith("content://" + context.getPackageName() + ".fileprovider/"));
            assertTrue(result.getString("storageRef").matches("^evidence/v1/objects/[0-9a-f-]+\\.[a-z0-9]+$"));
            assertTrue(result.getInt("evidenceId") > 0);
            assertNotEquals("UNAVAILABLE", result.getString("testedGitCommitSha"));
            assertEquals(40, result.getString("testedGitCommitSha").length());

            final JSONArray events = result.getJSONArray("events");
            assertTrue(events.length() >= 7);
            assertTrue(indexOf(events, "storage.publish.complete") < indexOf(events, "db.beginImmediate.start"));
            assertTrue(indexOf(events, "storage.publish.complete") < indexOf(events, "db.evidenceInsert.start"));
            assertTrue(indexOf(events, "db.evidenceInsert.complete") < indexOf(events, "db.commit.complete"));

            System.out.println(
                "GATE6C_INTEGRATION_PASS api=" + Build.VERSION.SDK_INT +
                " testedSha=" + result.getString("testedGitCommitSha") +
                " evidenceId=" + result.getInt("evidenceId") +
                " storageRef=" + result.getString("storageRef") +
                " bytes=" + result.getLong("persistedSize") +
                " hash=" + result.getString("persistedHash") +
                " events=" + events.toString()
            );
        } finally {
            deleteRecursively(new File(context.getFilesDir(), "evidence"));
            assertTrue(source.delete() || !source.exists());
        }
    }

    private static void waitForProofFunction(ActivityScenario<MainActivity> scenario) throws Exception {
        for (int i = 0; i < 80; i++) {
            final Object value = decodeJsValue(evaluate(scenario, "typeof window.__gate6cRunIntegrationProof"));
            if ("function".equals(value)) return;
            SystemClock.sleep(250L);
        }
        throw new AssertionError("Gate 6C integration proof function did not become available in WebView");
    }

    private static String waitForProofResult(ActivityScenario<MainActivity> scenario) throws Exception {
        for (int i = 0; i < 240; i++) {
            final Object value = decodeJsValue(evaluate(scenario, "window.__gate6cIntegrationResult===null?null:window.__gate6cIntegrationResult"));
            if (value instanceof String && !((String) value).isEmpty()) return (String) value;
            SystemClock.sleep(250L);
        }
        throw new AssertionError("Gate 6C integration proof did not complete");
    }

    private static String evaluate(ActivityScenario<MainActivity> scenario, String script) throws Exception {
        final CountDownLatch latch = new CountDownLatch(1);
        final AtomicReference<String> result = new AtomicReference<>();
        scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript(script, value -> {
            result.set(value);
            latch.countDown();
        }));
        assertTrue("WebView evaluateJavascript callback timed out", latch.await(15, TimeUnit.SECONDS));
        return result.get();
    }

    private static Object decodeJsValue(String encoded) throws Exception {
        if (encoded == null) return null;
        final Object value = new JSONTokener(encoded).nextValue();
        return value == JSONObject.NULL ? null : value;
    }

    private static int indexOf(JSONArray values, String expected) throws Exception {
        for (int i = 0; i < values.length(); i++) if (expected.equals(values.getString(i))) return i;
        return Integer.MAX_VALUE;
    }

    private static File syntheticSource(Context context, String name, long size) throws Exception {
        final File file = new File(context.getCacheDir(), name);
        final byte[] buffer = new byte[8192];
        long written = 0L;
        try (FileOutputStream out = new FileOutputStream(file, false)) {
            while (written < size) {
                final int count = (int) Math.min(buffer.length, size - written);
                for (int i = 0; i < count; i++) buffer[i] = (byte) ((written + i) % 251);
                out.write(buffer, 0, count);
                written += count;
            }
            out.flush();
            out.getFD().sync();
        }
        assertEquals(size, file.length());
        return file;
    }

    private static String hash(File file) throws Exception {
        final MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (FileInputStream in = new FileInputStream(file)) {
            final byte[] buffer = new byte[16384];
            int read;
            while ((read = in.read(buffer)) != -1) digest.update(buffer, 0, read);
        }
        final StringBuilder out = new StringBuilder(71);
        out.append("sha256:");
        for (byte value : digest.digest()) out.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return out.toString();
    }

    private static void deleteRecursively(File file) {
        if (file == null || !file.exists()) return;
        if (file.isDirectory()) {
            final File[] children = file.listFiles();
            if (children != null) for (File child : children) deleteRecursively(child);
        }
        file.delete();
    }
}
