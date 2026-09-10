package com.scientifica.inspection.gate6bproof;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.system.OsConstants;
import androidx.core.content.FileProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class Gate6CEvidenceStoreInstrumentedTest {
    private Context context;
    private Gate6CEvidenceStore store;

    @Before
    public void setUp() throws Exception {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        deleteRecursively(new File(context.getFilesDir(), "evidence"));
        deleteRecursively(new File(context.getFilesDir(), "gate6c-renameat2-spike"));
        cleanSyntheticCache();
        store = new Gate6CEvidenceStore(context);
    }

    @After
    public void tearDown() {
        deleteRecursively(new File(context.getFilesDir(), "evidence"));
        deleteRecursively(new File(context.getFilesDir(), "gate6c-renameat2-spike"));
        cleanSyntheticCache();
    }

    @Test
    public void renameAt2NoReplaceSyscallReportsRequiredErrnos() throws Exception {
        File dir = new File(context.getFilesDir(), "gate6c-renameat2-spike");
        assertTrue(dir.mkdirs() || dir.isDirectory());

        File successSource = writeText(new File(dir, "success-source"), "complete-success-source");
        File successDestination = new File(dir, "success-destination");
        int successErrno = Gate6CAtomicPublisher.renameNoReplace(successSource, successDestination);
        assertEquals(0, successErrno);
        assertFalse(successSource.exists());
        assertEquals("complete-success-source", readText(successDestination));

        File collisionSource = writeText(new File(dir, "collision-source"), "replacement-bytes");
        File collisionDestination = writeText(new File(dir, "collision-destination"), "preserved-destination");
        String collisionSourceHash = hash(collisionSource);
        String preservedHash = hash(collisionDestination);
        int collisionErrno = Gate6CAtomicPublisher.renameNoReplace(collisionSource, collisionDestination);
        assertEquals(OsConstants.EEXIST, collisionErrno);
        assertEquals(collisionSourceHash, hash(collisionSource));
        assertEquals(preservedHash, hash(collisionDestination));
        assertEquals("preserved-destination", readText(collisionDestination));

        File invalidFlagSource = writeText(new File(dir, "invalid-flag-source"), "invalid-flag-source");
        File invalidFlagDestination = new File(dir, "invalid-flag-destination");
        int invalidFlagErrno = Gate6CAtomicPublisher.renameWithFlagsForTest(
            invalidFlagSource,
            invalidFlagDestination,
            Gate6CAtomicPublisher.RENAME_NOREPLACE | 0x40000000
        );
        assertEquals(OsConstants.EINVAL, invalidFlagErrno);
        assertTrue(invalidFlagSource.isFile());
        assertFalse(invalidFlagDestination.exists());

        File permissionSource = writeText(new File(dir, "permission-source"), "permission-source");
        File permissionDestination = new File("/data/local/tmp/gate6c-publication-denied-" + System.nanoTime());
        int permissionErrno = Gate6CAtomicPublisher.renameNoReplace(permissionSource, permissionDestination);
        assertTrue(permissionErrno == OsConstants.EACCES || permissionErrno == OsConstants.EPERM);
        assertTrue(permissionSource.isFile());
        assertFalse(permissionDestination.exists());

        File externalDir = context.getExternalFilesDir(null);
        assertNotNull(externalDir);
        File crossSource = writeText(new File(dir, "cross-source"), "cross-filesystem-source");
        File crossDestination = new File(externalDir, "gate6c-cross-destination-" + System.nanoTime());
        int crossFilesystemErrno = Gate6CAtomicPublisher.renameNoReplace(crossSource, crossDestination);
        assertEquals(OsConstants.EXDEV, crossFilesystemErrno);
        assertTrue(crossSource.isFile());
        assertFalse(crossDestination.exists());

        System.out.println(
            "GATE6C_RENAMEAT2_SPIKE api=" + Build.VERSION.SDK_INT +
            " success_errno=" + successErrno +
            " collision_errno=" + collisionErrno +
            " invalid_flag_errno=" + invalidFlagErrno +
            " permission_errno=" + permissionErrno +
            " cross_filesystem_errno=" + crossFilesystemErrno
        );
    }

    @Test
    public void allocationUsesCanonicalLowercaseUuidAndSafeExtension() {
        Gate6CEvidenceStore.Allocation a = store.allocate("Photo.JPEG", "image/jpeg");
        assertTrue(a.storageRef.matches("^evidence/v1/objects/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.jpg$"));
        assertTrue(a.stagingRef.matches("^evidence/v1/\\.incoming/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.part$"));
        assertEquals(uuidFromFinal(a.storageRef), uuidFromStaging(a.stagingRef));
        Gate6CEvidenceStore.Allocation unknown = store.allocate("opaque", "application/x-unknown-g6c");
        assertTrue(unknown.storageRef.endsWith(".bin"));
    }

    @Test
    public void contentUriStagesWithBoundedBufferExactBytesSizeAndSha256() throws Exception {
        File source = syntheticSource("content-source.bin", 1024L * 1024L + 123L);
        String expected = hash(source);
        Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", source);
        Gate6CEvidenceStore.Allocation a = store.allocate(source.getName(), "application/octet-stream");
        Gate6CEvidenceStore.StageResult staged = store.stage(uri.toString(), a.storageRef, a.stagingRef, source.getName(), "application/octet-stream", null);
        assertEquals(source.length(), staged.fileSize);
        assertEquals(expected, staged.contentHash);
        assertEquals(Gate6CEvidenceStore.COPY_BUFFER_BYTES, staged.bufferSizeBytes);
        assertEquals(expected, hash(store.stagingFileForTest(a.stagingRef)));
        assertFalse(store.finalExists(a.storageRef));
    }

    @Test
    public void fileUriStagesThroughSameStreamingPath() throws Exception {
        File source = syntheticSource("file-source.pdf", 256L * 1024L + 17L);
        Gate6CEvidenceStore.Allocation a = store.allocate(source.getName(), "application/pdf");
        Gate6CEvidenceStore.StageResult staged = store.stage(Uri.fromFile(source).toString(), a.storageRef, a.stagingRef, source.getName(), "application/pdf", null);
        assertEquals(source.length(), staged.fileSize);
        assertEquals(hash(source), staged.contentHash);
        assertTrue(a.storageRef.endsWith(".pdf"));
    }

    @Test
    public void largeSyntheticContentSourceRemainsStreamingAndHashCorrect() throws Exception {
        File source = syntheticSource("large-source.bin", Gate6CEvidenceStore.LARGE_SYNTHETIC_TEST_BYTES);
        Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", source);
        Gate6CEvidenceStore.Allocation a = store.allocate(source.getName(), "application/octet-stream");
        Gate6CEvidenceStore.StageResult staged = store.stage(uri.toString(), a.storageRef, a.stagingRef, source.getName(), "application/octet-stream", null);
        assertEquals(Gate6CEvidenceStore.LARGE_SYNTHETIC_TEST_BYTES, staged.fileSize);
        assertEquals(Gate6CEvidenceStore.COPY_BUFFER_BYTES, staged.bufferSizeBytes);
        assertEquals(hash(source), staged.contentHash);
        assertTrue(staged.fileSize > (long) staged.bufferSizeBytes * 400L);
    }

    @Test
    public void missingSourceFailsBeforeFinalPublication() throws Exception {
        Gate6CEvidenceStore.Allocation a = store.allocate("missing.bin", "application/octet-stream");
        assertThrows(IOException.class, () -> store.stage("file:///definitely/missing/gate6c.bin", a.storageRef, a.stagingRef, "missing.bin", "application/octet-stream", null));
        assertFalse(store.finalExists(a.storageRef));
    }

    @Test
    public void stagingCollisionFailsClosedWithoutFinalObject() throws Exception {
        File source = syntheticSource("collision.bin", 4096);
        Gate6CEvidenceStore.Allocation a = store.allocate(source.getName(), "application/octet-stream");
        assertTrue(store.stagingFileForTest(a.stagingRef).createNewFile());
        assertThrows(IOException.class, () -> store.stage(Uri.fromFile(source).toString(), a.storageRef, a.stagingRef, source.getName(), "application/octet-stream", null));
        assertFalse(store.finalExists(a.storageRef));
    }

    @Test
    public void completeStagePublishesExactFinalObjectAndRemovesIncoming() throws Exception {
        File source = syntheticSource("publish.bin", 128L * 1024L + 9L);
        Gate6CEvidenceStore.Allocation a = stageSource(source);
        String stagedHash = hash(store.stagingFileForTest(a.stagingRef));
        assertFalse(store.finalExists(a.storageRef));
        Gate6CEvidenceStore.PublishResult published = store.publish(a.storageRef, a.stagingRef);
        assertTrue(store.finalExists(a.storageRef));
        assertFalse(store.stagingFileForTest(a.stagingRef).exists());
        assertEquals(stagedHash, published.contentHash);
        assertEquals(stagedHash, hash(store.finalFileForTest(a.storageRef)));
        assertEquals(source.length(), published.fileSize);
    }

    @Test
    public void publishNeverOverwritesExistingDestination() throws Exception {
        File original = syntheticSource("original.bin", 64L * 1024L + 1L);
        Gate6CEvidenceStore.Allocation a = stageSource(original);
        Gate6CEvidenceStore.PublishResult first = store.publish(a.storageRef, a.stagingRef);
        String preservedHash = first.contentHash;
        long preservedSize = first.fileSize;

        File replacement = syntheticSource("replacement.bin", 96L * 1024L + 3L);
        store.stage(Uri.fromFile(replacement).toString(), a.storageRef, a.stagingRef, replacement.getName(), "application/octet-stream", null);
        String replacementStagingHash = hash(store.stagingFileForTest(a.stagingRef));
        IOException collision = assertThrows(IOException.class, () -> store.publish(a.storageRef, a.stagingRef));
        assertTrue(collision.getMessage().contains("errno=" + OsConstants.EEXIST));
        assertEquals(preservedHash, hash(store.finalFileForTest(a.storageRef)));
        assertEquals(preservedSize, store.finalFileForTest(a.storageRef).length());
        assertEquals(replacementStagingHash, hash(store.stagingFileForTest(a.stagingRef)));
        assertNotEquals(hash(replacement), preservedHash);
    }

    @Test
    public void interruptionBeforeFinalEntryLeavesNoFinalObject() throws Exception {
        File source = syntheticSource("before-interrupt.bin", 32768);
        Gate6CEvidenceStore.Allocation a = stageSource(source);
        assertThrows(IOException.class, () -> store.publish(a.storageRef, a.stagingRef, Gate6CEvidenceStore.PublishFault.BEFORE_FINAL_ENTRY));
        assertFalse(store.finalExists(a.storageRef));
        assertTrue(store.stagingFileForTest(a.stagingRef).isFile());
    }

    @Test
    public void interruptionAfterAtomicPublicationLeavesCompleteFinalWithoutStagingPath() throws Exception {
        File source = syntheticSource("after-interrupt.bin", 131073);
        Gate6CEvidenceStore.Allocation a = stageSource(source);
        String stagedHash = hash(store.stagingFileForTest(a.stagingRef));
        long stagedSize = store.stagingFileForTest(a.stagingRef).length();
        assertThrows(IOException.class, () -> store.publish(a.storageRef, a.stagingRef, Gate6CEvidenceStore.PublishFault.AFTER_ATOMIC_PUBLICATION_BEFORE_DURABILITY_SYNC));
        assertTrue(store.finalExists(a.storageRef));
        assertFalse(store.stagingFileForTest(a.stagingRef).exists());
        assertEquals(stagedHash, hash(store.finalFileForTest(a.storageRef)));
        assertEquals(stagedSize, store.finalFileForTest(a.storageRef).length());
    }

    @Test
    public void finalExistsStatResolveAndHashFailClosedOnBadReferences() throws Exception {
        List<String> malformed = Arrays.asList(
            "/data/user/0/x",
            "../objects/x",
            "evidence/v1/objects/../../x.bin",
            "content://provider/x",
            "evidence\\v1\\objects\\x.bin",
            "evidence/v1/objects/%2e%2e.bin"
        );
        for (String ref : malformed) {
            assertThrows(IOException.class, () -> store.finalExists(ref));
            assertThrows(IOException.class, () -> store.stat(ref));
            assertThrows(IOException.class, () -> store.resolve(ref));
        }
    }

    @Test
    public void statResolveAndVerifyHashUseActualFinalObject() throws Exception {
        File source = syntheticSource("resolve.bin", 77777);
        Gate6CEvidenceStore.Allocation a = stageSource(source);
        Gate6CEvidenceStore.PublishResult p = store.publish(a.storageRef, a.stagingRef);
        assertEquals(p.fileSize, store.stat(a.storageRef).fileSize);
        assertEquals(p.contentHash, store.verifyHash(a.storageRef, p.contentHash).hash);
        assertNotEquals(p.contentHash, store.verifyHash(a.storageRef, "sha256:" + repeat('0', 64)).hash.equals("sha256:" + repeat('0', 64)) ? p.contentHash : "sha256:" + repeat('0', 64));
        String handle = store.resolve(a.storageRef);
        assertTrue(handle.startsWith("content://" + context.getPackageName() + ".fileprovider/"));
        try (InputStream in = context.getContentResolver().openInputStream(Uri.parse(handle))) {
            assertNotNull(in);
            assertTrue(in.read() >= 0);
        }
    }

    @Test
    public void managedEnumerationClassifiesFinalIncomingAndUnknownConservatively() throws Exception {
        File finalSource = syntheticSource("enum-final.bin", 2000);
        Gate6CEvidenceStore.Allocation finalA = stageSource(finalSource);
        store.publish(finalA.storageRef, finalA.stagingRef);
        File incomingSource = syntheticSource("enum-incoming.bin", 3000);
        Gate6CEvidenceStore.Allocation incomingA = stageSource(incomingSource);
        File unknown = new File(store.rootForTest(), "objects/not-canonical.tmp");
        assertTrue(unknown.createNewFile());
        List<Gate6CEvidenceStore.ManagedObject> objects = store.listManagedObjects();
        assertTrue(has(objects, "FINAL", finalA.storageRef));
        assertTrue(has(objects, "INCOMING", incomingA.stagingRef));
        assertTrue(has(objects, "UNKNOWN", "evidence/v1/objects/not-canonical.tmp"));
    }

    @Test
    public void removalOperationsAreNamespaceSpecific() throws Exception {
        File source = syntheticSource("remove.bin", 2048);
        Gate6CEvidenceStore.Allocation a = stageSource(source);
        assertThrows(IOException.class, () -> store.removeIncoming(a.storageRef));
        assertThrows(IOException.class, () -> store.removeConfirmedOrphan(a.stagingRef));
        assertTrue(store.stagingFileForTest(a.stagingRef).exists());
        store.removeIncoming(a.stagingRef);
        assertFalse(store.stagingFileForTest(a.stagingRef).exists());

        Gate6CEvidenceStore.Allocation b = stageSource(source);
        store.publish(b.storageRef, b.stagingRef);
        store.removeConfirmedOrphan(b.storageRef);
        assertFalse(store.finalExists(b.storageRef));
    }

    @Test
    public void newStoreInstanceRetrievesPublishedAppPrivateObjectAfterRuntimeRecreation() throws Exception {
        File source = syntheticSource("restart.bin", 40960);
        Gate6CEvidenceStore.Allocation a = stageSource(source);
        Gate6CEvidenceStore.PublishResult p = store.publish(a.storageRef, a.stagingRef);
        Gate6CEvidenceStore reopened = new Gate6CEvidenceStore(context);
        assertTrue(reopened.finalExists(a.storageRef));
        assertEquals(p.fileSize, reopened.stat(a.storageRef).fileSize);
        assertEquals(p.contentHash, reopened.verifyHash(a.storageRef, p.contentHash).hash);
    }

    @Test
    public void genericPickerIntentIsOpenDocumentSingleOpenableReadOnlyContract() {
        Intent intent = Gate6CEvidencePlugin.buildGenericFileIntent();
        assertEquals(Intent.ACTION_OPEN_DOCUMENT, intent.getAction());
        assertTrue(intent.hasCategory(Intent.CATEGORY_OPENABLE));
        assertEquals("*/*", intent.getType());
        assertFalse(intent.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, true));
        assertTrue((intent.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0);
        assertEquals(0, intent.getFlags() & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        assertEquals(0, intent.getFlags() & Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
    }

    @Test
    public void contentSourceIsIndependentFromExternalUriAfterPublication() throws Exception {
        File source = syntheticSource("independent.bin", 123456);
        Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", source);
        Gate6CEvidenceStore.Allocation a = store.allocate(source.getName(), "application/octet-stream");
        store.stage(uri.toString(), a.storageRef, a.stagingRef, source.getName(), "application/octet-stream", null);
        Gate6CEvidenceStore.PublishResult p = store.publish(a.storageRef, a.stagingRef);
        assertTrue(source.delete());
        assertTrue(store.finalExists(a.storageRef));
        assertEquals(p.contentHash, store.verifyHash(a.storageRef, p.contentHash).hash);
    }

    private Gate6CEvidenceStore.Allocation stageSource(File source) throws Exception {
        Gate6CEvidenceStore.Allocation a = store.allocate(source.getName(), "application/octet-stream");
        store.stage(Uri.fromFile(source).toString(), a.storageRef, a.stagingRef, source.getName(), "application/octet-stream", null);
        return a;
    }

    private File syntheticSource(String name, long size) throws Exception {
        File file = new File(context.getCacheDir(), "gate6c-" + name);
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[8192];
        long written = 0;
        try (FileOutputStream out = new FileOutputStream(file, false)) {
            while (written < size) {
                int count = (int) Math.min(buffer.length, size - written);
                for (int i = 0; i < count; i++) buffer[i] = (byte) ((written + i) % 251);
                out.write(buffer, 0, count);
                digest.update(buffer, 0, count);
                written += count;
            }
            out.flush();
            out.getFD().sync();
        }
        assertEquals(size, file.length());
        return file;
    }

    private File writeText(File file, String value) throws Exception {
        try (FileOutputStream out = new FileOutputStream(file, false)) {
            out.write(value.getBytes("UTF-8"));
            out.flush();
            out.getFD().sync();
        }
        return file;
    }

    private String readText(File file) throws Exception {
        byte[] bytes = new byte[(int) file.length()];
        try (FileInputStream in = new FileInputStream(file)) {
            int offset = 0;
            while (offset < bytes.length) {
                int read = in.read(bytes, offset, bytes.length - offset);
                if (read < 0) break;
                offset += read;
            }
            assertEquals(bytes.length, offset);
        }
        return new String(bytes, "UTF-8");
    }

    private String hash(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (FileInputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[16384];
            int read;
            while ((read = in.read(buffer)) != -1) digest.update(buffer, 0, read);
        }
        return "sha256:" + lowerHex(digest.digest());
    }

    private static String lowerHex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) out.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return out.toString();
    }

    private static String uuidFromFinal(String ref) {
        String name = ref.substring(ref.lastIndexOf('/') + 1);
        return name.substring(0, name.lastIndexOf('.'));
    }

    private static String uuidFromStaging(String ref) {
        String name = ref.substring(ref.lastIndexOf('/') + 1);
        return name.substring(0, name.length() - ".part".length());
    }

    private static boolean has(List<Gate6CEvidenceStore.ManagedObject> values, String kind, String ref) {
        for (Gate6CEvidenceStore.ManagedObject value : values) if (kind.equals(value.kind) && ref.equals(value.ref)) return true;
        return false;
    }

    private static String repeat(char value, int count) {
        char[] chars = new char[count];
        Arrays.fill(chars, value);
        return new String(chars);
    }

    private void cleanSyntheticCache() {
        File[] files = context.getCacheDir().listFiles((dir, name) -> name.startsWith("gate6c-"));
        if (files != null) for (File file : files) deleteRecursively(file);
    }

    private static void deleteRecursively(File file) {
        if (file == null || !file.exists()) return;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) for (File child : children) deleteRecursively(child);
        }
        file.delete();
    }
}
