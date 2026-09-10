package com.scientifica.inspection.gate6bproof;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.webkit.MimeTypeMap;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Gate 6C-C filesystem mechanics only. No domain SQL, owner selection or Evidence INSERT logic lives here.
 */
final class Gate6CEvidenceStore {
    static final int COPY_BUFFER_BYTES = 64 * 1024;
    static final long LARGE_SYNTHETIC_TEST_BYTES = 32L * 1024L * 1024L;

    private static final String ROOT_RELATIVE = "evidence/v1";
    private static final String OBJECTS_RELATIVE = ROOT_RELATIVE + "/objects";
    private static final String INCOMING_RELATIVE = ROOT_RELATIVE + "/.incoming";
    private static final String UUID_V4 = "([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
    private static final Pattern FINAL_REF = Pattern.compile("^" + OBJECTS_RELATIVE + "/" + UUID_V4 + "\\.([a-z0-9]+)$");
    private static final Pattern STAGING_REF = Pattern.compile("^" + INCOMING_RELATIVE + "/" + UUID_V4 + "\\.part$");
    private static final Pattern SHA256 = Pattern.compile("^sha256:[0-9a-f]{64}$");
    private static final Pattern SAFE_EXTENSION = Pattern.compile("^[a-z0-9]+$");

    enum PublishFault {
        NONE,
        BEFORE_FINAL_ENTRY,
        AFTER_ATOMIC_PUBLICATION_BEFORE_DURABILITY_SYNC
    }

    static final class Allocation {
        final String storageRef;
        final String stagingRef;
        Allocation(String storageRef, String stagingRef) {
            this.storageRef = storageRef;
            this.stagingRef = stagingRef;
        }
    }

    static final class StageResult {
        final String storageRef;
        final String stagingRef;
        final String fileName;
        final String mimeType;
        final long fileSize;
        final String contentHash;
        final String capturedAt;
        final int bufferSizeBytes;
        StageResult(String storageRef, String stagingRef, String fileName, String mimeType, long fileSize, String contentHash, String capturedAt) {
            this.storageRef = storageRef;
            this.stagingRef = stagingRef;
            this.fileName = fileName;
            this.mimeType = mimeType;
            this.fileSize = fileSize;
            this.contentHash = contentHash;
            this.capturedAt = capturedAt;
            this.bufferSizeBytes = COPY_BUFFER_BYTES;
        }
    }

    static final class PublishResult {
        final String storageRef;
        final long fileSize;
        final String contentHash;
        PublishResult(String storageRef, long fileSize, String contentHash) {
            this.storageRef = storageRef;
            this.fileSize = fileSize;
            this.contentHash = contentHash;
        }
    }

    static final class StatResult {
        final String storageRef;
        final long fileSize;
        StatResult(String storageRef, long fileSize) {
            this.storageRef = storageRef;
            this.fileSize = fileSize;
        }
    }

    static final class HashResult {
        final long bytes;
        final String hash;
        HashResult(long bytes, String hash) {
            this.bytes = bytes;
            this.hash = hash;
        }
    }

    static final class ManagedObject {
        final String kind;
        final String ref;
        ManagedObject(String kind, String ref) {
            this.kind = kind;
            this.ref = ref;
        }
    }

    private final Context context;
    private final ContentResolver resolver;
    private final File root;
    private final File objectsDir;
    private final File incomingDir;

    Gate6CEvidenceStore(Context context) throws IOException {
        this.context = context.getApplicationContext();
        this.resolver = this.context.getContentResolver();
        this.root = new File(this.context.getFilesDir(), ROOT_RELATIVE).getCanonicalFile();
        this.objectsDir = new File(root, "objects").getCanonicalFile();
        this.incomingDir = new File(root, ".incoming").getCanonicalFile();
        requireInsideFiles(root);
        requireInsideRoot(objectsDir);
        requireInsideRoot(incomingDir);
        ensureDirectory(objectsDir);
        ensureDirectory(incomingDir);
    }

    Allocation allocate(String displayName, String declaredMimeType) {
        final String token = UUID.randomUUID().toString().toLowerCase(Locale.ROOT);
        final String extension = chooseSafeExtension(displayName, declaredMimeType);
        return new Allocation(
            OBJECTS_RELATIVE + "/" + token + "." + extension,
            INCOMING_RELATIVE + "/" + token + ".part"
        );
    }

    StageResult stage(
        String sourceRef,
        String storageRef,
        String stagingRef,
        String displayName,
        String declaredMimeType,
        String capturedAt
    ) throws IOException {
        final Matcher finalMatch = requireFinal(storageRef);
        final Matcher stagingMatch = requireStaging(stagingRef);
        if (!finalMatch.group(1).equals(stagingMatch.group(1))) {
            throw new IOException("Gate 6C allocation UUID mismatch");
        }
        final Uri source = parseSourceUri(sourceRef);
        final File staging = stagingFile(stagingRef);
        final String mime = sourceMime(source, declaredMimeType);
        final String fileName = sourceDisplayName(source, displayName, finalMatch.group(2));
        final MessageDigest digest = sha256Digest();
        long bytes = 0L;

        FileDescriptor outputFd = null;
        try (InputStream input = resolver.openInputStream(source)) {
            if (input == null) throw new FileNotFoundException("Source provider returned no readable stream");
            outputFd = Os.open(
                staging.getAbsolutePath(),
                OsConstants.O_WRONLY | OsConstants.O_CREAT | OsConstants.O_EXCL,
                0600
            );
            try (FileOutputStream output = new FileOutputStream(outputFd)) {
                outputFd = null; // owned by the stream now
                final byte[] buffer = new byte[COPY_BUFFER_BYTES];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    output.write(buffer, 0, read);
                    digest.update(buffer, 0, read);
                    bytes += read;
                }
                output.flush();
                output.getFD().sync();
            }
            fsyncDirectory(incomingDir);
        } catch (ErrnoException e) {
            if (outputFd != null) {
                try { Os.close(outputFd); } catch (ErrnoException ignored) { }
            }
            throw new IOException("Unable to create exclusive staging object", e);
        }

        final long actualLength = staging.length();
        if (actualLength != bytes) throw new IOException("Staged byte count disagrees with filesystem length");
        return new StageResult(
            storageRef,
            stagingRef,
            fileName,
            mime,
            bytes,
            "sha256:" + lowerHex(digest.digest()),
            normalizeNullable(capturedAt)
        );
    }

    boolean finalExists(String storageRef) throws IOException {
        return finalFile(storageRef).isFile();
    }

    PublishResult publish(String storageRef, String stagingRef) throws IOException {
        return publish(storageRef, stagingRef, PublishFault.NONE);
    }

    PublishResult publish(String storageRef, String stagingRef, PublishFault fault) throws IOException {
        final Matcher finalMatch = requireFinal(storageRef);
        final Matcher stagingMatch = requireStaging(stagingRef);
        if (!finalMatch.group(1).equals(stagingMatch.group(1))) throw new IOException("Gate 6C publish UUID mismatch");
        final File staging = stagingFile(stagingRef);
        final File destination = finalFile(storageRef);
        if (!staging.isFile()) throw new FileNotFoundException("Complete staging object is missing");
        if (fault == PublishFault.BEFORE_FINAL_ENTRY) throw new IOException("TEST_ONLY: interrupted before atomic publication");

        final long stagedLength = staging.length();
        final int publishErrno = Gate6CAtomicPublisher.renameNoReplace(staging, destination);
        if (publishErrno != 0) {
            throw new IOException("Atomic no-replace publication failed: errno=" + publishErrno);
        }

        if (fault == PublishFault.AFTER_ATOMIC_PUBLICATION_BEFORE_DURABILITY_SYNC) {
            throw new IOException("TEST_ONLY: interrupted after atomic publication before directory durability sync");
        }

        fsyncDirectory(objectsDir);
        fsyncDirectory(incomingDir);

        final HashResult published = hashFile(destination);
        if (published.bytes != stagedLength) throw new IOException("Published object length differs from complete staging object");
        if (staging.exists()) throw new IOException("Atomic publication left staging pathname present");
        return new PublishResult(storageRef, published.bytes, published.hash);
    }

    StatResult stat(String storageRef) throws IOException {
        final File file = finalFile(storageRef);
        if (!file.isFile()) throw new FileNotFoundException("Managed final object is missing");
        return new StatResult(storageRef, file.length());
    }

    String resolve(String storageRef) throws IOException {
        final File file = finalFile(storageRef);
        if (!file.isFile()) throw new FileNotFoundException("Managed final object is missing");
        final Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
        return uri.toString();
    }

    List<ManagedObject> listManagedObjects() throws IOException {
        final List<ManagedObject> out = new ArrayList<>();
        listDirectory(incomingDir, true, out);
        listDirectory(objectsDir, false, out);
        final File[] rootEntries = root.listFiles();
        if (rootEntries == null) throw new IOException("Managed root cannot be enumerated");
        for (File entry : rootEntries) {
            if (entry.equals(incomingDir) || entry.equals(objectsDir)) continue;
            out.add(new ManagedObject("UNKNOWN", ROOT_RELATIVE + "/" + entry.getName()));
        }
        out.sort(Comparator.comparing((ManagedObject value) -> value.ref).thenComparing(value -> value.kind));
        return out;
    }

    void removeIncoming(String stagingRef) throws IOException {
        final File file = stagingFile(stagingRef);
        if (file.exists() && !file.isFile()) throw new IOException("Incoming reference does not identify a regular file");
        if (file.exists() && !file.delete()) throw new IOException("Incoming object could not be removed");
        fsyncDirectory(incomingDir);
    }

    void removeConfirmedOrphan(String storageRef) throws IOException {
        final File file = finalFile(storageRef);
        if (file.exists() && !file.isFile()) throw new IOException("Final reference does not identify a regular file");
        if (file.exists() && !file.delete()) throw new IOException("Confirmed orphan could not be removed");
        fsyncDirectory(objectsDir);
    }

    HashResult verifyHash(String storageRef, String expectedHash) throws IOException {
        if (expectedHash == null || !SHA256.matcher(expectedHash).matches()) throw new IOException("Expected hash is not canonical SHA-256");
        return hashFile(finalFile(storageRef));
    }

    File finalFileForTest(String storageRef) throws IOException { return finalFile(storageRef); }
    File stagingFileForTest(String stagingRef) throws IOException { return stagingFile(stagingRef); }
    File rootForTest() { return root; }

    private void listDirectory(File directory, boolean staging, List<ManagedObject> out) throws IOException {
        final File[] entries = directory.listFiles();
        if (entries == null) throw new IOException("Managed Evidence namespace cannot be enumerated");
        for (File entry : entries) {
            final String ref = (staging ? INCOMING_RELATIVE : OBJECTS_RELATIVE) + "/" + entry.getName();
            final boolean regular = entry.isFile();
            final boolean canonical = staging ? STAGING_REF.matcher(ref).matches() : FINAL_REF.matcher(ref).matches();
            out.add(new ManagedObject(regular && canonical ? (staging ? "INCOMING" : "FINAL") : "UNKNOWN", ref));
        }
    }

    private HashResult hashFile(File file) throws IOException {
        if (!file.isFile()) throw new FileNotFoundException("Managed file is missing");
        final MessageDigest digest = sha256Digest();
        long bytes = 0L;
        try (FileInputStream input = new FileInputStream(file)) {
            final byte[] buffer = new byte[COPY_BUFFER_BYTES];
            int read;
            while ((read = input.read(buffer)) != -1) {
                digest.update(buffer, 0, read);
                bytes += read;
            }
        }
        return new HashResult(bytes, "sha256:" + lowerHex(digest.digest()));
    }

    private Uri parseSourceUri(String sourceRef) throws IOException {
        if (sourceRef == null || sourceRef.trim().isEmpty()) throw new IOException("sourceRef is required");
        final Uri uri = Uri.parse(sourceRef);
        final String scheme = uri.getScheme();
        if (!ContentResolver.SCHEME_CONTENT.equals(scheme) && !ContentResolver.SCHEME_FILE.equals(scheme)) {
            throw new IOException("Unsupported Evidence source URI scheme");
        }
        return uri;
    }

    private String sourceDisplayName(Uri source, String fallback, String extension) {
        if (ContentResolver.SCHEME_CONTENT.equals(source.getScheme())) {
            try (Cursor cursor = resolver.query(source, new String[]{ OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    final int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (index >= 0) {
                        final String value = normalizeDisplayName(cursor.getString(index));
                        if (value != null) return value;
                    }
                }
            } catch (RuntimeException ignored) {
                // Provider display metadata is descriptive only; the durable byte stream remains authoritative.
            }
        }
        final String normalizedFallback = normalizeDisplayName(fallback);
        return normalizedFallback == null ? "evidence." + extension : normalizedFallback;
    }

    private String sourceMime(Uri source, String fallback) {
        try {
            final String fromProvider = normalizeMime(resolver.getType(source));
            if (fromProvider != null) return fromProvider;
        } catch (RuntimeException ignored) { }
        final String normalizedFallback = normalizeMime(fallback);
        return normalizedFallback == null ? "application/octet-stream" : normalizedFallback;
    }

    private String chooseSafeExtension(String displayName, String declaredMimeType) {
        final String mime = normalizeMime(declaredMimeType);
        if (mime != null) {
            final String mapped = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
            if (isSafeExtension(mapped)) return mapped.toLowerCase(Locale.ROOT);
            if ("image/jpeg".equals(mime)) return "jpg";
            if ("image/heic".equals(mime)) return "heic";
            if ("image/heif".equals(mime)) return "heif";
        }
        final String name = normalizeDisplayName(displayName);
        if (name != null) {
            final int dot = name.lastIndexOf('.');
            if (dot >= 0 && dot + 1 < name.length()) {
                final String candidate = name.substring(dot + 1).toLowerCase(Locale.ROOT);
                if (candidate.length() <= 12 && isSafeExtension(candidate)) return candidate;
            }
        }
        return "bin";
    }

    private boolean isSafeExtension(String value) {
        return value != null && value.length() <= 12 && SAFE_EXTENSION.matcher(value).matches();
    }

    private String normalizeDisplayName(String value) {
        if (value == null) return null;
        final String normalized = value.replace('\r', ' ').replace('\n', ' ').trim();
        if (normalized.isEmpty()) return null;
        return normalized.length() > 240 ? normalized.substring(0, 240) : normalized;
    }

    private String normalizeMime(String value) {
        if (value == null) return null;
        final String normalized = value.trim().toLowerCase(Locale.ROOT);
        if (normalized.isEmpty() || normalized.length() > 120 || normalized.indexOf('/') <= 0) return null;
        return normalized;
    }

    private String normalizeNullable(String value) {
        if (value == null) return null;
        final String normalized = value.trim();
        return normalized.isEmpty() ? null : normalized;
    }

    private Matcher requireFinal(String ref) throws IOException {
        if (ref == null || ref.indexOf('%') >= 0 || ref.indexOf('\\') >= 0 || ref.contains("..") || ref.contains("://")) {
            throw new IOException("Malformed final Evidence storage_ref");
        }
        final Matcher matcher = FINAL_REF.matcher(ref);
        if (!matcher.matches()) throw new IOException("Malformed final Evidence storage_ref");
        return matcher;
    }

    private Matcher requireStaging(String ref) throws IOException {
        if (ref == null || ref.indexOf('%') >= 0 || ref.indexOf('\\') >= 0 || ref.contains("..") || ref.contains("://")) {
            throw new IOException("Malformed Evidence staging_ref");
        }
        final Matcher matcher = STAGING_REF.matcher(ref);
        if (!matcher.matches()) throw new IOException("Malformed Evidence staging_ref");
        return matcher;
    }

    private File finalFile(String ref) throws IOException {
        requireFinal(ref);
        final String name = ref.substring((OBJECTS_RELATIVE + "/").length());
        final File file = new File(objectsDir, name).getCanonicalFile();
        requireInside(file, objectsDir);
        return file;
    }

    private File stagingFile(String ref) throws IOException {
        requireStaging(ref);
        final String name = ref.substring((INCOMING_RELATIVE + "/").length());
        final File file = new File(incomingDir, name).getCanonicalFile();
        requireInside(file, incomingDir);
        return file;
    }

    private void requireInsideFiles(File file) throws IOException { requireInside(file, context.getFilesDir().getCanonicalFile()); }
    private void requireInsideRoot(File file) throws IOException { requireInside(file, root); }

    private void requireInside(File file, File parent) throws IOException {
        final String parentPath = parent.getCanonicalPath() + File.separator;
        final String path = file.getCanonicalPath();
        if (!path.startsWith(parentPath) && !path.equals(parent.getCanonicalPath())) {
            throw new IOException("Managed Evidence path escaped app-private root");
        }
    }

    private void ensureDirectory(File directory) throws IOException {
        if (directory.isDirectory()) return;
        if (!directory.mkdirs() && !directory.isDirectory()) throw new IOException("Unable to create managed Evidence directory");
    }

    private void fsyncDirectory(File directory) throws IOException {
        FileDescriptor fd = null;
        try {
            fd = Os.open(directory.getAbsolutePath(), OsConstants.O_RDONLY, 0);
            Os.fsync(fd);
        } catch (ErrnoException e) {
            throw new IOException("Unable to fsync Evidence directory", e);
        } finally {
            if (fd != null) {
                try { Os.close(fd); } catch (ErrnoException ignored) { }
            }
        }
    }

    private MessageDigest sha256Digest() throws IOException {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException impossible) {
            throw new IOException("SHA-256 is unavailable", impossible);
        }
    }

    private String lowerHex(byte[] bytes) {
        final StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) out.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return out.toString();
    }
}
