// Narrow Windows read-only asset backend. Build with MSVC; no external libraries.
// Usage: georama-win-asset-read.exe <absolute-drive-root> <relative/asset> <max-bytes>
// stdout: verified bytes only; nonzero exit: a single path-free error code on stderr.
// The caller MUST enforce the same path/extension/size policy. This helper checks
// its inputs independently as a second boundary.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <fcntl.h>
#include <io.h>
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cwchar>
#include <cwctype>
#include <string>
#include <vector>

namespace {
constexpr unsigned long long kHardCap = 64ULL * 1024 * 1024;
constexpr DWORD kFlags = FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT;
constexpr DWORD kShare = FILE_SHARE_READ | FILE_SHARE_WRITE;  // deliberately NO FILE_SHARE_DELETE

struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  explicit Handle(HANDLE h = INVALID_HANDLE_VALUE) : value(h) {}
  ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value(other.value) { other.value = INVALID_HANDLE_VALUE; }
  Handle& operator=(Handle&& other) noexcept {
    if (this != &other) {
      if (value != INVALID_HANDLE_VALUE) CloseHandle(value);
      value = other.value;
      other.value = INVALID_HANDLE_VALUE;
    }
    return *this;
  }
  explicit operator bool() const { return value != INVALID_HANDLE_VALUE; }
};

int fail(const char* code) {
  std::fprintf(stderr, "%s\n", code);
  return 1;
}

bool badChar(wchar_t c) {
  return c < 0x20 || (c >= 0x7f && c <= 0x9f) ||
    c == L'<' || c == L'>' || c == L':' || c == L'"' ||
    c == L'|' || c == L'?' || c == L'*' ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069) ||
    c == 0x2028 || c == 0x2029 || c == 0xfeff;
}

bool deviceName(const std::wstring& name) {
  const size_t dot = name.find(L'.');
  std::wstring base = name.substr(0, dot);
  std::transform(base.begin(), base.end(), base.begin(), [](wchar_t c) { return static_cast<wchar_t>(std::towupper(c)); });
  if (base == L"CON" || base == L"PRN" || base == L"AUX" || base == L"NUL" ||
      base == L"CONIN$" || base == L"CONOUT$") return true;
  if (base.size() == 4 && (base.substr(0, 3) == L"COM" || base.substr(0, 3) == L"LPT")) {
    const wchar_t digit = base[3];
    if ((digit >= L'1' && digit <= L'9') || digit == 0x00b9 || digit == 0x00b2 || digit == 0x00b3) return true;
  }
  return false;
}

bool component(const std::wstring& name) {
  if (name.empty() || name == L"." || name == L".." ||
      name.back() == L'.' || name.back() == L' ' || deviceName(name)) return false;
  for (const auto c : name) {
    if (badChar(c) || c == L'\\' || c == L'/') return false;
  }
  // This also rejects malformed UTF-16 (including lone surrogate halves).
  const int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS,
    name.data(), static_cast<int>(name.size()), nullptr, 0, nullptr, nullptr);
  return bytes > 0 && bytes <= 255;
}

bool validRoot(const std::wstring& root) {
  if (root.size() < 3 || root.size() > 4096 ||
      !((root[0] >= L'A' && root[0] <= L'Z') || (root[0] >= L'a' && root[0] <= L'z')) ||
      root[1] != L':' || root[2] != L'\\') return false;
  if (root.size() == 3) return true;
  size_t start = 3;
  while (start < root.size()) {
    const size_t end = root.find(L'\\', start);
    const size_t next = end == std::wstring::npos ? root.size() : end;
    if (!component(root.substr(start, next - start))) return false;
    if (end == std::wstring::npos) break;
    start = end + 1;
  }
  // Only a bare drive root may end in a backslash. A trailing separator on
  // any other root would be a noncanonical spelling accepted by Win32.
  return start < root.size();
}

bool validRelative(const std::wstring& relative, std::vector<std::wstring>& parts) {
  if (relative.empty() || relative.size() > 4096) return false;
  size_t start = 0;
  while (start < relative.size()) {
    if (parts.size() == 16) return false;
    const size_t end = relative.find(L'/', start);
    const size_t next = end == std::wstring::npos ? relative.size() : end;
    std::wstring part = relative.substr(start, next - start);
    if (!component(part)) return false;
    parts.push_back(std::move(part));
    if (end == std::wstring::npos) break;
    start = end + 1;
  }
  if (parts.empty() || relative.back() == L'/') return false;
  for (size_t i = 0; i + 1 < parts.size(); ++i) {
    if (parts[i][0] == L'.') return false;
  }
  const auto& last = parts.back();
  if (last[0] == L'.' && last != L".wonderdraft_symbols") return false;
  const std::wstring suffixes[] = { L".png", L".wonderdraft_image",
    L".wonderdraft_symbols", L".wonderdraft_theme" };
  for (const auto& suffix : suffixes) {
    if (last.size() >= suffix.size() && last.compare(last.size() - suffix.size(), suffix.size(), suffix) == 0)
      return true;
  }
  return false;
}

const char* openError() {
  const DWORD code = GetLastError();
  if (code == ERROR_FILE_NOT_FOUND || code == ERROR_PATH_NOT_FOUND ||
      code == ERROR_INVALID_DRIVE) return "MISSING";
  return "IO";
}

bool attributes(HANDLE h, FILE_ATTRIBUTE_TAG_INFO& info) {
  return GetFileType(h) == FILE_TYPE_DISK &&
    GetFileInformationByHandleEx(h, FileAttributeTagInfo, &info, sizeof(info)) != 0;
}

bool nameOf(HANDLE h, std::wstring& result) {
  const DWORD flags = FILE_NAME_NORMALIZED | VOLUME_NAME_DOS;
  const DWORD needed = GetFinalPathNameByHandleW(h, nullptr, 0, flags);
  if (needed == 0 || needed > 32760) return false;
  std::vector<wchar_t> buffer(static_cast<size_t>(needed) + 1);
  const DWORD got = GetFinalPathNameByHandleW(h, buffer.data(), static_cast<DWORD>(buffer.size()), flags);
  if (got == 0 || static_cast<size_t>(got) >= buffer.size()) return false;
  result.assign(buffer.data(), got);
  // Only a DOS-volume path can be compared to the authorized drive root.
  return result.size() >= 7 && result.compare(0, 4, L"\\\\?\\") == 0 &&
    ((result[4] >= L'A' && result[4] <= L'Z') || (result[4] >= L'a' && result[4] <= L'z')) &&
    result[5] == L':' && result[6] == L'\\';
}

bool sameName(const std::wstring& expected, const std::wstring& actual) {
  return _wcsicmp(expected.c_str(), actual.c_str()) == 0;
}

struct Snapshot {
  FILE_BASIC_INFO basic{};
  FILE_STANDARD_INFO standard{};
  BY_HANDLE_FILE_INFORMATION id{};
};

bool snapshot(HANDLE handle, Snapshot& s) {
  return GetFileInformationByHandleEx(handle, FileBasicInfo, &s.basic, sizeof(s.basic)) != 0 &&
    GetFileInformationByHandleEx(handle, FileStandardInfo, &s.standard, sizeof(s.standard)) != 0 &&
    GetFileInformationByHandle(handle, &s.id) != 0;
}

bool sameSnapshot(const Snapshot& a, const Snapshot& b) {
  return a.standard.EndOfFile.QuadPart == b.standard.EndOfFile.QuadPart &&
    a.standard.Directory == b.standard.Directory &&
    a.basic.LastWriteTime.QuadPart == b.basic.LastWriteTime.QuadPart &&
    a.basic.ChangeTime.QuadPart == b.basic.ChangeTime.QuadPart &&
    a.id.nNumberOfLinks == b.id.nNumberOfLinks &&
    a.id.dwVolumeSerialNumber == b.id.dwVolumeSerialNumber &&
    a.id.nFileIndexHigh == b.id.nFileIndexHigh &&
    a.id.nFileIndexLow == b.id.nFileIndexLow;
}

bool parseCap(const wchar_t* input, unsigned long long& cap) {
  if (!input || !*input) return false;
  unsigned long long value = 0;
  for (const wchar_t* p = input; *p; ++p) {
    if (*p < L'0' || *p > L'9') return false;
    const auto digit = static_cast<unsigned>(*p - L'0');
    if (value > (kHardCap - digit) / 10) return false;
    value = value * 10 + digit;
  }
  cap = value;
  return true;
}
} // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc != 4) return fail("PATH");
  const std::wstring root(argv[1]), relative(argv[2]);
  unsigned long long cap = 0;
  std::vector<std::wstring> parts;
  if (!validRoot(root) || !validRelative(relative, parts)) return fail("PATH");
  if (!parseCap(argv[3], cap)) return fail("LIMIT");

  // Retain every ancestor HANDLE and never share DELETE, so each checked name
  // and object cannot be renamed while traversal continues. Each new object
  // is opened as a no-follow leaf; resolved handle names must match the held
  // parent's final DOS path exactly. No pathname precheck is used for access.
  std::vector<Handle> held;
  held.reserve(parts.size() + 1);
  held.emplace_back(CreateFileW(root.c_str(), FILE_READ_ATTRIBUTES, kShare, nullptr,
    OPEN_EXISTING, kFlags, nullptr));
  if (!held.back()) return fail(openError());
  FILE_ATTRIBUTE_TAG_INFO tag{};
  if (!attributes(held.back().value, tag)) return fail("IO");
  if ((tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return fail("PATH");
  if ((tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) return fail("TYPE");

  std::wstring parent;
  if (!nameOf(held.back().value, parent)) return fail("IO");
  // Opening a selected root with OPEN_REPARSE_POINT only protects the final
  // component. An ancestor may still be a junction. Reject any root whose
  // held handle resolves to a different DOS path than the authorized spelling.
  if (!sameName(std::wstring(L"\\\\?\\") + root, parent)) return fail("PATH");
  if (parent.back() == L'\\' && parent.size() > 7) parent.pop_back();

  for (size_t i = 0; i < parts.size(); ++i) {
    const bool leaf = i + 1 == parts.size();
    const std::wstring expected = parent + (parent.back() == L'\\' ? L"" : L"\\") + parts[i];
    const DWORD access = leaf ? GENERIC_READ : FILE_READ_ATTRIBUTES;
    // The final file refuses WRITE sharing as well as DELETE, so a concurrent
    // writer cannot keep mutating the bytes while we take a bounded snapshot.
    const DWORD share = leaf ? FILE_SHARE_READ : kShare;
    held.emplace_back(CreateFileW(expected.c_str(), access, share, nullptr,
      OPEN_EXISTING, kFlags, nullptr));
    if (!held.back()) return fail(openError());
    if (!attributes(held.back().value, tag)) return fail("IO");
    if ((tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return fail("PATH");
    if ((tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ? leaf : !leaf) return fail("TYPE");

    std::wstring actual;
    if (!nameOf(held.back().value, actual)) return fail("IO");
    if (!sameName(expected, actual)) return fail("PATH");
    parent = std::move(actual);
  }

  HANDLE file = held.back().value;
  Snapshot before{}, after{};
  if (!snapshot(file, before)) return fail("IO");
  if (before.standard.Directory) return fail("TYPE");
  // A hardlink beneath the root may name a file also reachable outside it.
  // Refuse multi-link files rather than claiming containment based on a name.
  if (before.id.nNumberOfLinks != 1) return fail("PATH");
  const LONGLONG size = before.standard.EndOfFile.QuadPart;
  if (size < 0) return fail("IO");
  if (static_cast<unsigned long long>(size) > cap) return fail("LIMIT");
  std::vector<unsigned char> bytes(static_cast<size_t>(size));
  size_t done = 0;
  while (done < bytes.size()) {
    const DWORD ask = static_cast<DWORD>(std::min<size_t>(1024 * 1024, bytes.size() - done));
    DWORD got = 0;
    if (!ReadFile(file, bytes.data() + done, ask, &got, nullptr)) return fail("IO");
    if (got == 0 || got > ask) return fail("IO");
    done += got;
  }
  unsigned char extra = 0;
  DWORD extraRead = 0;
  if (!ReadFile(file, &extra, 1, &extraRead, nullptr)) return fail("IO");
  if (extraRead != 0 || !snapshot(file, after) || !sameSnapshot(before, after)) return fail("IO");

  // Never emit partial unverified contents. Only write once all checks pass.
  if (_setmode(_fileno(stdout), _O_BINARY) == -1) return fail("IO");
  size_t sent = 0;
  while (sent < bytes.size()) {
    const unsigned count = static_cast<unsigned>(std::min<size_t>(1024 * 1024, bytes.size() - sent));
    const int n = _write(_fileno(stdout), bytes.data() + sent, count);
    if (n <= 0) return 1;
    sent += static_cast<size_t>(n);
  }
  return 0;
}
