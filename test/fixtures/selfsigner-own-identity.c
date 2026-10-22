/* Hosted-only fixture diagnostic. No key export, signing or trust
 * changes. */
#include <CommonCrypto/CommonDigest.h>
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
static void stage(const char *name, OSStatus status, int present) {
  printf("{\"stage\":\"%s\",\"status\":%d,\"present\":%d}\n", name, (int)status,
         present);
}
static int owned_regular(const char *path) {
  struct stat s;
  return lstat(path, &s) == 0 && S_ISREG(s.st_mode) && s.st_uid == getuid() &&
         s.st_nlink == 1 && !(s.st_mode & 077);
}
/* Public query equivalent: only the explicit fixture keychain, never ambient
 * search. */
static void policy_search(const char *name, SecKeychainRef keychain,
                          SecCertificateRef expected, SecPolicyRef policy) {
  CFArrayRef search =
      CFArrayCreate(NULL, (const void **)&keychain, 1, &kCFTypeArrayCallBacks);
  CFMutableDictionaryRef query =
      CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks,
                                &kCFTypeDictionaryValueCallBacks);
  if (!search || !query) {
    stage(name, errSecAllocate, 0);
    if (search)
      CFRelease(search);
    if (query)
      CFRelease(query);
    return;
  }
  CFDictionarySetValue(query, kSecClass, kSecClassIdentity);
  CFDictionarySetValue(query, kSecMatchSearchList, search);
  CFDictionarySetValue(query, kSecMatchTrustedOnly, kCFBooleanFalse);
  CFDictionarySetValue(query, kSecAttrCanSign, kCFBooleanTrue);
  CFDictionarySetValue(query, kSecReturnRef, kCFBooleanTrue);
  CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
  if (policy)
    CFDictionarySetValue(query, kSecMatchPolicy, policy);
  CFTypeRef result = NULL;
  OSStatus status = SecItemCopyMatching(query, &result);
  stage(name, status, result != NULL);
  if (!status && result && CFGetTypeID(result) == SecIdentityGetTypeID()) {
    SecCertificateRef selected = NULL;
    OSStatus copied =
        SecIdentityCopyCertificate((SecIdentityRef)result, &selected);
    CFDataRef wanted = SecCertificateCopyData(expected);
    CFDataRef actual = selected ? SecCertificateCopyData(selected) : NULL;
    int equal = !copied && wanted && actual && CFEqual(wanted, actual);
    stage(policy ? "policy-search-exact-certificate"
                 : "plain-search-exact-certificate",
          equal ? 0 : errSecItemNotFound, equal);
    if (wanted)
      CFRelease(wanted);
    if (actual)
      CFRelease(actual);
    if (selected)
      CFRelease(selected);
  } else if (!status) {
    stage("identity-search-unexpected-type", errSecParam, 0);
  }
  if (result)
    CFRelease(result);
  CFRelease(query);
  CFRelease(search);
}
int main(int argc, char **argv) {
  const char *intent = getenv("PACER_OWN_CERT_ORDER_CONTROL"),
             *actions = getenv("GITHUB_ACTIONS"),
             *host = getenv("RUNNER_ENVIRONMENT"),
             *parent = getenv("RUNNER_TEMP");
  if (argc != 3 || !intent || strcmp(intent, "1") || !actions ||
      strcmp(actions, "true") || !host || strcmp(host, "github-hosted") ||
      !parent)
    return 2;
  char expected[PATH_MAX], root[PATH_MAX], kcpath[PATH_MAX], derpath[PATH_MAX];
  struct stat directory;
  if (snprintf(expected, sizeof(expected), "%s/pacer-own-cert-order-control",
               parent) >= (int)sizeof(expected) ||
      !realpath(argv[1], root) || strcmp(root, argv[1]) ||
      strcmp(root, expected) || lstat(root, &directory) ||
      !S_ISDIR(directory.st_mode) || directory.st_uid != getuid() ||
      (directory.st_mode & 077))
    return 2;
  if (strlen(argv[2]) != 40 || strspn(argv[2], "0123456789ABCDEF") != 40)
    return 2;
  if (snprintf(kcpath, sizeof(kcpath), "%s/test.keychain-db", root) >=
          (int)sizeof(kcpath) ||
      snprintf(derpath, sizeof(derpath), "%s/cert.der", root) >=
          (int)sizeof(derpath) ||
      !owned_regular(kcpath) || !owned_regular(derpath))
    return 2;
  int fd = open(derpath, O_RDONLY | O_NOFOLLOW);
  struct stat before, after;
  if (fd < 0)
    return 2;
  if (fstat(fd, &before) || !S_ISREG(before.st_mode) ||
      before.st_uid != getuid() || before.st_nlink != 1 || before.st_size < 1 ||
      before.st_size > 1048576) {
    close(fd);
    return 2;
  }
  unsigned char *bytes = malloc((size_t)before.st_size);
  if (!bytes) {
    close(fd);
    return 2;
  }
  size_t offset = 0;
  while (offset < (size_t)before.st_size) {
    ssize_t n = read(fd, bytes + offset, (size_t)before.st_size - offset);
    if (n <= 0) {
      free(bytes);
      close(fd);
      return 2;
    }
    offset += (size_t)n;
  }
  if (fstat(fd, &after) || before.st_dev != after.st_dev ||
      before.st_ino != after.st_ino || before.st_size != after.st_size ||
      before.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec ||
      before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec) {
    free(bytes);
    close(fd);
    return 2;
  }
  close(fd);
  unsigned char hash[CC_SHA1_DIGEST_LENGTH];
  CC_SHA1(bytes, (CC_LONG)offset, hash);
  char hex[41];
  for (unsigned i = 0; i < 20; i++)
    snprintf(hex + 2 * i, 3, "%02X", hash[i]);
  if (strcmp(hex, argv[2])) {
    free(bytes);
    return 2;
  }
  CFDataRef data = CFDataCreate(NULL, bytes, (CFIndex)offset);
  free(bytes);
  if (!data)
    return 2;
  SecCertificateRef certificate = SecCertificateCreateWithData(NULL, data);
  CFRelease(data);
  stage("certificate-object", certificate ? 0 : errSecDecode,
        certificate != NULL);
  if (!certificate)
    return 1;
  SecKeychainRef keychain = NULL;
  OSStatus status = SecKeychainOpen(kcpath, &keychain);
  stage("open-own-keychain", status, keychain != NULL);
  if (status || !keychain) {
    CFRelease(certificate);
    return 1;
  }
  SecIdentityRef identity = NULL;
  status = SecIdentityCreateWithCertificate(keychain, certificate, &identity);
  stage("identity-from-own-certificate", status, identity != NULL);
  if (status || !identity) {
    CFRelease(keychain);
    CFRelease(certificate);
    return 1;
  }
  SecCertificateRef selected = NULL;
  status = SecIdentityCopyCertificate(identity, &selected);
  stage("copy-identity-certificate", status, selected != NULL);
  int success = status == 0 && selected != NULL;
  if (selected) {
    CFDataRef original = SecCertificateCopyData(certificate),
              chosen = SecCertificateCopyData(selected);
    int equal = original && chosen && CFEqual(original, chosen);
    stage("exact-certificate-match", equal ? 0 : errSecItemNotFound, equal);
    success = success && equal;
    if (original)
      CFRelease(original);
    if (chosen)
      CFRelease(chosen);
    CFRelease(selected);
  }
  if (!success) {
    CFRelease(identity);
    CFRelease(keychain);
    CFRelease(certificate);
    return 1;
  }
  SecKeyRef private_key = NULL;
  status = SecIdentityCopyPrivateKey(identity, &private_key);
  stage("copy-private-key-handle-only", status, private_key != NULL);
  success = success && status == 0 && private_key != NULL;
  policy_search("plain-identity-search", keychain, certificate, NULL);
  SecPolicyRef policy =
      SecPolicyCreateWithProperties(kSecPolicyAppleCodeSigning, NULL);
  stage("create-code-signing-policy", policy ? 0 : errSecParam, policy != NULL);
  if (policy) {
    policy_search("code-signing-identity-search", keychain, certificate,
                  policy);
    CFRelease(policy);
  }
  if (private_key)
    CFRelease(private_key);
  CFRelease(identity);
  CFRelease(keychain);
  CFRelease(certificate);
  return success ? 0 : 1;
}
