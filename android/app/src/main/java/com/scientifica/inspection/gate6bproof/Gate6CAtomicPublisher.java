package com.scientifica.inspection.gate6bproof;

import java.io.File;

/**
 * Minimal JNI seam for atomic no-replace publication. The native side uses only public NDK/libc
 * facilities and the Linux renameat2 syscall; no hidden Android symbols or privileged APIs.
 */
final class Gate6CAtomicPublisher {
    static final int RENAME_NOREPLACE = 1;

    static {
        System.loadLibrary("gate6c_atomic_publish");
    }

    private Gate6CAtomicPublisher() { }

    static int renameNoReplace(File source, File destination) {
        return nativeRenameAt2(source.getAbsolutePath(), destination.getAbsolutePath(), RENAME_NOREPLACE);
    }

    static int renameWithFlagsForTest(File source, File destination, int flags) {
        return nativeRenameAt2(source.getAbsolutePath(), destination.getAbsolutePath(), flags);
    }

    private static native int nativeRenameAt2(String sourcePath, String destinationPath, int flags);
}
