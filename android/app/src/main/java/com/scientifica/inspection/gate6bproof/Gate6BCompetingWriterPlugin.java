package com.scientifica.inspection.gate6bproof;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabaseLockedException;
import android.database.sqlite.SQLiteException;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.IOException;
import net.zetetic.database.sqlcipher.SQLiteDatabase;

@CapacitorPlugin(name = "Gate6BCompetingWriter")
public final class Gate6BCompetingWriterPlugin extends Plugin {
    private static final String EXPECTED_BASENAME = "inspection_gate6b_adapter_probe_v1SQLite.db";
    private static final String MARKER_PREFIX = "g6b-q12-";
    private static final String NATIVE_ENGINE = "sqlcipher-android-4.17.0";
    private static final String SQLITE_TABLE_LOCKED = "android.database.sqlite.SQLiteTableLockedException";
    private SQLiteDatabase competingDb;

    @PluginMethod
    public synchronized void open(PluginCall call) {
        if (competingDb != null && competingDb.isOpen()) {
            call.reject("Gate6B Q12 competing writer is already open");
            return;
        }
        final String suppliedPath = call.getString("databasePath");
        if (suppliedPath == null || suppliedPath.isBlank()) {
            call.reject("Gate6B Q12 databasePath is required");
            return;
        }

        SQLiteDatabase opened = null;
        try {
            final File target = validateTarget(suppliedPath);
            System.loadLibrary("sqlcipher");
            opened = SQLiteDatabase.openDatabase(
                target.getAbsolutePath(),
                "",
                null,
                SQLiteDatabase.OPEN_READWRITE,
                null
            );
            opened.execSQL("PRAGMA busy_timeout = 0;");
            final long busyTimeout = scalarLong(opened, "PRAGMA busy_timeout;");
            final String sqliteVersion = scalarText(opened, "SELECT sqlite_version();");
            final File openedMain = mainDatabaseFile(opened);
            final boolean samePhysicalFile = openedMain.getCanonicalFile().equals(target.getCanonicalFile());
            scalarLong(opened, "SELECT count(*) FROM __g6b_probe;");

            competingDb = opened;
            opened = null;
            JSObject result = new JSObject();
            result.put("samePhysicalFile", samePhysicalFile);
            result.put("databaseBasename", target.getName());
            result.put("nativeEngine", NATIVE_ENGINE);
            result.put("sqliteVersion", sqliteVersion);
            result.put("busyTimeoutMs", busyTimeout);
            result.put("probeTableReadable", true);
            call.resolve(result);
        } catch (Exception error) {
            if (opened != null && opened.isOpen()) opened.close();
            call.reject("Gate6B Q12 native open failed: " + error.getClass().getName());
        }
    }

    @PluginMethod
    public synchronized void insertMarker(PluginCall call) {
        final SQLiteDatabase db = competingDb;
        if (db == null || !db.isOpen()) {
            call.reject("Gate6B Q12 competing writer is not open");
            return;
        }
        final String marker = call.getString("marker");
        if (marker == null || !marker.startsWith(MARKER_PREFIX) || marker.length() > 96) {
            call.reject("Gate6B Q12 marker is outside the synthetic diagnostic namespace");
            return;
        }

        try {
            db.execSQL("INSERT INTO __g6b_probe(text_value) VALUES (?)", new Object[] { marker });
            call.resolve(writeResult("SUCCESS", null, null));
        } catch (SQLiteDatabaseLockedException busy) {
            call.resolve(writeResult("BUSY", busy.getClass().getName(), 5));
        } catch (SQLiteException sqliteError) {
            if (SQLITE_TABLE_LOCKED.equals(sqliteError.getClass().getName())) {
                call.resolve(writeResult("LOCKED", sqliteError.getClass().getName(), 6));
            } else {
                call.resolve(writeResult("ERROR", sqliteError.getClass().getName(), null));
            }
        } catch (Exception error) {
            call.resolve(writeResult("ERROR", error.getClass().getName(), null));
        }
    }

    @PluginMethod
    public synchronized void close(PluginCall call) {
        try {
            if (competingDb != null) {
                if (competingDb.isOpen()) competingDb.close();
                competingDb = null;
            }
            JSObject result = new JSObject();
            result.put("closed", true);
            call.resolve(result);
        } catch (Exception error) {
            competingDb = null;
            call.reject("Gate6B Q12 native close failed: " + error.getClass().getName());
        }
    }

    @Override
    protected synchronized void handleOnDestroy() {
        try {
            if (competingDb != null && competingDb.isOpen()) competingDb.close();
        } catch (Exception ignored) {
            // Diagnostic teardown is best-effort on Activity destruction; explicit Q12 close is separately qualified.
        } finally {
            competingDb = null;
            super.handleOnDestroy();
        }
    }

    private File validateTarget(String suppliedPath) throws IOException {
        final File supplied = new File(suppliedPath).getCanonicalFile();
        final File expected = getContext().getDatabasePath(EXPECTED_BASENAME).getCanonicalFile();
        final File databaseDir = expected.getParentFile().getCanonicalFile();
        final File suppliedParent = supplied.getParentFile() == null ? null : supplied.getParentFile().getCanonicalFile();
        if (!EXPECTED_BASENAME.equals(supplied.getName())) throw new IOException("unexpected database basename");
        if (suppliedParent == null || !suppliedParent.equals(databaseDir)) throw new IOException("database path outside app-private database directory");
        if (!supplied.equals(expected)) throw new IOException("database path does not match Gate6B probe database");
        if (!supplied.exists() || !supplied.isFile()) throw new IOException("Gate6B probe database does not already exist");
        return supplied;
    }

    private static File mainDatabaseFile(SQLiteDatabase db) throws IOException {
        try (Cursor cursor = db.rawQuery("PRAGMA database_list;", null)) {
            final int nameIndex = cursor.getColumnIndexOrThrow("name");
            final int fileIndex = cursor.getColumnIndexOrThrow("file");
            while (cursor.moveToNext()) {
                if ("main".equals(cursor.getString(nameIndex))) {
                    return new File(cursor.getString(fileIndex)).getCanonicalFile();
                }
            }
        }
        throw new IOException("PRAGMA database_list did not expose main database");
    }

    private static long scalarLong(SQLiteDatabase db, String sql) {
        try (Cursor cursor = db.rawQuery(sql, null)) {
            if (!cursor.moveToFirst()) throw new SQLiteException("scalar query returned no rows");
            return cursor.getLong(0);
        }
    }

    private static String scalarText(SQLiteDatabase db, String sql) {
        try (Cursor cursor = db.rawQuery(sql, null)) {
            if (!cursor.moveToFirst()) throw new SQLiteException("scalar query returned no rows");
            return cursor.getString(0);
        }
    }

    private static JSObject writeResult(String outcome, String exceptionClass, Integer sqliteResultCode) {
        JSObject result = new JSObject();
        result.put("outcome", outcome);
        if (exceptionClass != null) result.put("exceptionClass", exceptionClass);
        if (sqliteResultCode != null) result.put("sqliteResultCode", sqliteResultCode);
        return result;
    }
}
