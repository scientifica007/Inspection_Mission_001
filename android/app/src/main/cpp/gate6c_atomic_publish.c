#include <jni.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef SYS_renameat2
#ifdef __NR_renameat2
#define SYS_renameat2 __NR_renameat2
#else
#error "renameat2 syscall number is unavailable for this NDK ABI"
#endif
#endif

JNIEXPORT jint JNICALL
Java_com_scientifica_inspection_gate6bproof_Gate6CAtomicPublisher_nativeRenameAt2(
    JNIEnv *env,
    jclass clazz,
    jstring source_path,
    jstring destination_path,
    jint flags
) {
    (void) clazz;
    if (source_path == NULL || destination_path == NULL) return EINVAL;

    const char *source = (*env)->GetStringUTFChars(env, source_path, NULL);
    if (source == NULL) return ENOMEM;
    const char *destination = (*env)->GetStringUTFChars(env, destination_path, NULL);
    if (destination == NULL) {
        (*env)->ReleaseStringUTFChars(env, source_path, source);
        return ENOMEM;
    }

    errno = 0;
    const long result = syscall(
        SYS_renameat2,
        AT_FDCWD,
        source,
        AT_FDCWD,
        destination,
        (unsigned int) flags
    );
    const int saved_errno = result == 0 ? 0 : errno;

    (*env)->ReleaseStringUTFChars(env, destination_path, destination);
    (*env)->ReleaseStringUTFChars(env, source_path, source);
    return saved_errno;
}
