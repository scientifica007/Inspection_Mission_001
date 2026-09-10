package com.scientifica.inspection.gate6bproof;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;

@CapacitorPlugin(name = "Gate6CEvidence")
public final class Gate6CEvidencePlugin extends Plugin {
    private Gate6CEvidenceStore store;

    @Override
    public void load() {
        super.load();
        try {
            store = new Gate6CEvidenceStore(getContext());
        } catch (IOException error) {
            store = null;
        }
    }

    @PluginMethod
    public void chooseGenericFile(PluginCall call) {
        final Intent intent = buildGenericFileIntent();
        try {
            startActivityForResult(call, intent, "genericFileResult");
        } catch (RuntimeException error) {
            reject(call, "G6C_UNSUPPORTED_SOURCE", "Generic system file picker is unavailable", error);
        }
    }

    @ActivityCallback
    private void genericFileResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() == Activity.RESULT_CANCELED) {
            JSObject out = new JSObject();
            out.put("status", "USER_CANCELLED");
            call.resolve(out);
            return;
        }
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            resolveAcquisitionFailure(call, "SOURCE_UNAVAILABLE", "System picker returned no readable document URI");
            return;
        }
        final Uri uri = result.getData().getData();
        final String scheme = uri.getScheme();
        if (!ContentResolver.SCHEME_CONTENT.equals(scheme) && !ContentResolver.SCHEME_FILE.equals(scheme)) {
            resolveAcquisitionFailure(call, "UNSUPPORTED_SOURCE", "System picker returned unsupported URI scheme");
            return;
        }
        final ContentResolver resolver = getContext().getContentResolver();
        try (InputStream input = resolver.openInputStream(uri)) {
            if (input == null) {
                resolveAcquisitionFailure(call, "SOURCE_UNAVAILABLE", "Selected source cannot provide a byte stream");
                return;
            }
        } catch (SecurityException denied) {
            resolveAcquisitionFailure(call, "PERMISSION_DENIED", "Selected source access was denied");
            return;
        } catch (FileNotFoundException missing) {
            resolveAcquisitionFailure(call, "SOURCE_UNAVAILABLE", "Selected source no longer exists");
            return;
        } catch (IOException unreadable) {
            resolveAcquisitionFailure(call, "SOURCE_UNAVAILABLE", "Selected source cannot be opened");
            return;
        }

        final JSObject out = new JSObject();
        out.put("status", "SUCCESS");
        out.put("sourceRef", uri.toString());
        final String displayName = queryDisplayName(getContext(), uri);
        if (displayName != null) out.put("displayName", displayName);
        final String mime = resolver.getType(uri);
        if (mime != null && !mime.isBlank()) out.put("declaredMimeType", mime);
        final Long size = querySize(getContext(), uri);
        if (size != null && size >= 0) out.put("sizeHint", size);
        call.resolve(out);
    }

    @PluginMethod
    public void allocate(PluginCall call) {
        final Gate6CEvidenceStore value = requireStore(call);
        if (value == null) return;
        try {
            final Gate6CEvidenceStore.Allocation a = value.allocate(call.getString("displayName"), call.getString("declaredMimeType"));
            final JSObject out = new JSObject();
            out.put("storageRef", a.storageRef);
            out.put("stagingRef", a.stagingRef);
            call.resolve(out);
        } catch (RuntimeException error) {
            reject(call, "G6C_STORAGE_WRITE_FAILED", "Evidence allocation failed", error);
        }
    }

    @PluginMethod
    public void stage(PluginCall call) {
        final Gate6CEvidenceStore value = requireStore(call);
        if (value == null) return;
        try {
            final Gate6CEvidenceStore.StageResult staged = value.stage(
                required(call, "sourceRef"),
                required(call, "storageRef"),
                required(call, "stagingRef"),
                call.getString("displayName"),
                call.getString("declaredMimeType"),
                call.getString("capturedAt")
            );
            final JSObject out = new JSObject();
            out.put("storageRef", staged.storageRef);
            out.put("stagingRef", staged.stagingRef);
            out.put("fileName", staged.fileName);
            out.put("mimeType", staged.mimeType);
            out.put("fileSize", staged.fileSize);
            out.put("contentHash", staged.contentHash);
            out.put("capturedAt", staged.capturedAt == null ? JSObject.NULL : staged.capturedAt);
            out.put("bufferSizeBytes", staged.bufferSizeBytes);
            call.resolve(out);
        } catch (SecurityException denied) {
            reject(call, "G6C_PERMISSION_DENIED", "Evidence source access denied", denied);
        } catch (FileNotFoundException missing) {
            reject(call, "G6C_SOURCE_UNAVAILABLE", "Evidence source is unavailable", missing);
        } catch (IllegalArgumentException badInput) {
            reject(call, "G6C_BAD_REFERENCE", "Evidence staging request is invalid", badInput);
        } catch (IOException error) {
            reject(call, "G6C_STORAGE_WRITE_FAILED", "Evidence staging failed", error);
        }
    }

    @PluginMethod
    public void finalExists(PluginCall call) {
        final Gate6CEvidenceStore value = requireStore(call);
        if (value == null) return;
        try {
            final JSObject out = new JSObject();
            out.put("exists", value.finalExists(required(call, "storageRef")));
            call.resolve(out);
        } catch (Exception error) {
            reject(call, "G6C_BAD_REFERENCE", "Evidence final-path check failed", error);
        }
    }

    @PluginMethod
    public void publish(PluginCall call) {
        final Gate6CEvidenceStore value = requireStore(call);
        if (value == null) return;
        try {
            final Gate6CEvidenceStore.PublishResult published = value.publish(required(call, "storageRef"), required(call, "stagingRef"));
            final JSObject out = new JSObject();
            out.put("storageRef", published.storageRef);
            out.put("fileSize", published.fileSize);
            out.put("contentHash", published.contentHash);
            call.resolve(out);
        } catch (Exception error) {
            reject(call, "G6C_STORAGE_WRITE_FAILED", "Evidence complete-object publication failed without replacement", error);
        }
    }

    @PluginMethod
    public void stat(PluginCall call) {
        final Gate6CEvidenceStore value = requireStore(call);
        if (value == null) return;
        try {
            final Gate6CEvidenceStore.StatResult stat = value.stat(required(call, "storageRef"));
            final JSObject out = new JSObject();
            out.put("storageRef", stat.storageRef);
            out.put("fileSize", stat.fileSize);
            call.resolve(out);
        } catch (FileNotFoundException missing) {
            reject(call, "G6C_BROKEN_STORAGE_REFERENCE", "Evidence final object is missing", missing);
        } catch (Exception error) {
            reject(call, "G6C_BAD_REFERENCE", "Evidence stat failed", error);
        }
    }

    @PluginMethod
    public void resolve(PluginCall call) {
        final Gate6CEvidenceStore value = requireStore(call);
        if (value == null) return;
        try {
            final String storageRef = required(call, "storageRef");
            final JSObject out = new JSObject();
            out.put("storageRef", storageRef);
            out.put("handleRef", value.resolve(storageRef));
            call.resolve(out);
        } catch (FileNotFoundException missing) {
            reject(call, "G6C_BROKEN_STORAGE_REFERENCE", "Evidence final object is missing", missing);
        } catch (Exception error) {
            reject(call, "G6C_BAD_REFERENCE", "Evidence resolve failed", error);
        }
    }

    @PluginMethod
    public void listManagedObjects(PluginCall call) {
        final Gate6CEvidenceStore value = requireStore(call);
        if (value == null) return;
        try {
            final JSArray objects = new JSArray();
            for (Gate6CEvidenceStore.ManagedObject object : value.listManagedObjects()) {
                final JSObject item = new JSObject();
                item.put("kind", object.kind);
                item.put("ref", object.ref);
                objects.put(item);
            }
            final JSObject out = new JSObject();
            out.put("objects", objects);
            call.resolve(out);
        } catch (Exception error) {
            reject(call, "G6C_STORAGE_WRITE_FAILED", "Managed Evidence enumeration failed", error);
        }
    }

    @PluginMethod
    public void removeIncoming(PluginCall call) {
        final Gate6CEvidenceStore value = requireStore(call);
        if (value == null) return;
        try {
            value.removeIncoming(required(call, "stagingRef"));
            call.resolve();
        } catch (Exception error) {
            reject(call, "G6C_BAD_REFERENCE", "Incoming Evidence removal failed", error);
        }
    }

    @PluginMethod
    public void removeConfirmedOrphan(PluginCall call) {
        final Gate6CEvidenceStore value = requireStore(call);
        if (value == null) return;
        try {
            value.removeConfirmedOrphan(required(call, "storageRef"));
            call.resolve();
        } catch (Exception error) {
            reject(call, "G6C_BAD_REFERENCE", "Confirmed Evidence orphan removal failed", error);
        }
    }

    @PluginMethod
    public void verifyHash(PluginCall call) {
        final Gate6CEvidenceStore value = requireStore(call);
        if (value == null) return;
        try {
            final String storageRef = required(call, "storageRef");
            final String expected = required(call, "expectedHash");
            final Gate6CEvidenceStore.HashResult actual = value.verifyHash(storageRef, expected);
            final JSObject out = new JSObject();
            out.put("matches", expected.equals(actual.hash));
            out.put("actualHash", actual.hash);
            call.resolve(out);
        } catch (FileNotFoundException missing) {
            reject(call, "G6C_BROKEN_STORAGE_REFERENCE", "Evidence final object is missing", missing);
        } catch (Exception error) {
            reject(call, "G6C_BAD_REFERENCE", "Evidence hash verification failed", error);
        }
    }

    static Intent buildGenericFileIntent() {
        final Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return intent;
    }

    private Gate6CEvidenceStore requireStore(PluginCall call) {
        if (store != null) return store;
        try {
            store = new Gate6CEvidenceStore(getContext());
            return store;
        } catch (IOException error) {
            reject(call, "G6C_STORAGE_WRITE_FAILED", "App-private Evidence store is unavailable", error);
            return null;
        }
    }

    private static String required(PluginCall call, String key) {
        final String value = call.getString(key);
        if (value == null || value.isBlank()) throw new IllegalArgumentException(key + " is required");
        return value;
    }

    private static void resolveAcquisitionFailure(PluginCall call, String status, String detail) {
        final JSObject out = new JSObject();
        out.put("status", status);
        out.put("detail", detail);
        call.resolve(out);
    }

    private static void reject(PluginCall call, String code, String message, Exception error) {
        call.reject(message, code, error);
    }

    private static String queryDisplayName(Context context, Uri uri) {
        try (Cursor cursor = context.getContentResolver().query(uri, new String[]{ OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                final int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) {
                    final String value = cursor.getString(index);
                    if (value != null && !value.isBlank()) return value.replace('\r', ' ').replace('\n', ' ').trim();
                }
            }
        } catch (RuntimeException ignored) { }
        return null;
    }

    private static Long querySize(Context context, Uri uri) {
        try (Cursor cursor = context.getContentResolver().query(uri, new String[]{ OpenableColumns.SIZE }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                final int index = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (index >= 0 && !cursor.isNull(index)) return cursor.getLong(index);
            }
        } catch (RuntimeException ignored) { }
        return null;
    }
}
