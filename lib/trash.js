'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const CACHE_DIR = path.join(__dirname, '..', 'cache');
const WIN_TRASH_BIN = path.join(CACHE_DIR, 'win-trash.exe');

/** C# IFileOperation 源码（首次由 Windows 自带 csc.exe 编译为 9.5 KB 的 cache/win-trash.exe；也供 PowerShell 兜底共用） */
const WIN_TRASH_CS_CLASS = `
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class WinRecycleBin {
    [ComImport, Guid("3ad05575-8857-4850-9277-11b85bdb8e09")] private class FileOperation {}
    [ComImport, Guid("04b0f1a7-9490-44bc-96e1-4296a31252e2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOperationProgressSink {
        void StartOperations(); void FinishOperations(uint hrResult);
        void PreRenameItem(uint a, IShellItem b, [MarshalAs(UnmanagedType.LPWStr)] string c);
        void PostRenameItem(uint a, IShellItem b, [MarshalAs(UnmanagedType.LPWStr)] string c, uint d, IShellItem e);
        void PreMoveItem(uint a, IShellItem b, IShellItem c, [MarshalAs(UnmanagedType.LPWStr)] string d);
        void PostMoveItem(uint a, IShellItem b, IShellItem c, [MarshalAs(UnmanagedType.LPWStr)] string d, uint e, IShellItem f);
        void PreCopyItem(uint a, IShellItem b, IShellItem c, [MarshalAs(UnmanagedType.LPWStr)] string d);
        void PostCopyItem(uint a, IShellItem b, IShellItem c, [MarshalAs(UnmanagedType.LPWStr)] string d, uint e, IShellItem f);
        void PreDeleteItem(uint a, IShellItem b);
        void PostDeleteItem(uint dwFlags, IShellItem psiItem, uint hrDelete, IShellItem psiNewlyCreated);
        void PreNewItem(uint a, IShellItem b, [MarshalAs(UnmanagedType.LPWStr)] string c);
        void PostNewItem(uint a, IShellItem b, [MarshalAs(UnmanagedType.LPWStr)] string c, [MarshalAs(UnmanagedType.LPWStr)] string d, uint e, uint f, IShellItem g);
        void UpdateProgress(uint a, uint b); void ResetTimer(); void PauseTimer(); void ResumeTimer();
    }
    [ComImport, Guid("947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOperation {
        uint Advise(IFileOperationProgressSink pfops, out uint pdwCookie); uint Unadvise(uint dwCookie);
        uint SetOperationFlags(uint f);
        uint SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string m); uint SetProgressDialog(IntPtr p);
        uint SetProperties(IntPtr p); uint SetOwnerWindow(IntPtr h); uint ApplyPropertiesToItem(IShellItem i);
        uint ApplyPropertiesToItems(IntPtr p); uint RenameItem(IShellItem i, [MarshalAs(UnmanagedType.LPWStr)] string n, IntPtr p);
        uint RenameItems(IntPtr p, [MarshalAs(UnmanagedType.LPWStr)] string n);
        uint MoveItem(IShellItem i, IShellItem d, [MarshalAs(UnmanagedType.LPWStr)] string n, IntPtr p);
        uint MoveItems(IntPtr p, IShellItem d);
        uint CopyItem(IShellItem i, IShellItem d, [MarshalAs(UnmanagedType.LPWStr)] string n, IntPtr p);
        uint CopyItems(IntPtr p, IShellItem d);
        uint DeleteItem(IShellItem i, IntPtr p); uint DeleteItems(IntPtr p);
        uint NewItem(IShellItem d, uint a, [MarshalAs(UnmanagedType.LPWStr)] string n, [MarshalAs(UnmanagedType.LPWStr)] string t, IntPtr p);
        uint PerformOperations(); uint GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool b);
    }
    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }
    private class Sink : IFileOperationProgressSink {
        public uint LastErrHr = 0;
        public string LastErrName = "";
        public void StartOperations() {} public void FinishOperations(uint hrResult) {}
        public void PreRenameItem(uint a, IShellItem b, string c) {} public void PostRenameItem(uint a, IShellItem b, string c, uint d, IShellItem e) {}
        public void PreMoveItem(uint a, IShellItem b, IShellItem c, string d) {} public void PostMoveItem(uint a, IShellItem b, IShellItem c, string d, uint e, IShellItem f) {}
        public void PreCopyItem(uint a, IShellItem b, IShellItem c, string d) {} public void PostCopyItem(uint a, IShellItem b, IShellItem c, string d, uint e, IShellItem f) {}
        public void PreDeleteItem(uint a, IShellItem b) {}
        public void PostDeleteItem(uint dwFlags, IShellItem psiItem, uint hrDelete, IShellItem psiNewlyCreated) {
            if ((int)hrDelete < 0) {
                LastErrHr = hrDelete;
                try { string p; psiItem.GetDisplayName(0x80058000, out p); LastErrName = Path.GetFileName(p); } catch {}
            }
        }
        public void PreNewItem(uint a, IShellItem b, string c) {} public void PostNewItem(uint a, IShellItem b, string c, string d, uint e, uint f, IShellItem g) {}
        public void UpdateProgress(uint a, uint b) {} public void ResetTimer() {} public void PauseTimer() {} public void ResumeTimer() {}
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] private static extern int SHCreateItemFromParsingName(string p, IntPtr b, ref Guid r, out IShellItem v);

    private static string DescribeHr(uint hr, string fileName) {
        string prefix = string.IsNullOrEmpty(fileName) ? "" : (fileName + ": ");
        switch (hr) {
            case 0x80270027:
            case 0x80070020: return prefix + "文件正被其他程序占用，请关闭占用后重试";
            case 0x80070005: return prefix + "没有权限删除该文件";
            case 0x80070002: return prefix + "文件已不存在";
            case 0x80070003: return prefix + "找不到指定路径";
            case 0x80270020:
            case 0x80270037: return prefix + "文件过大，超过该磁盘回收站容量上限";
            case 0x80270021:
            case 0x80270039: return prefix + "该磁盘未启用回收站或回收站不可用";
            default: return prefix + "移入回收站失败 (0x" + hr.ToString("X8") + ")";
        }
    }

    public static void MoveToRecycleBin(string[] paths) {
        var remaining = new List<string>();
        foreach (string rp in paths) {
            string full = Path.GetFullPath(rp);
            if (File.Exists(full)) remaining.Add(full);
        }
        if (remaining.Count == 0) throw new FileNotFoundException("文件已不存在");

        uint lastHr = 0;
        string lastFile = "";
        for (int attempt = 0; attempt < 5 && remaining.Count > 0; attempt++) {
            if (attempt > 0) Thread.Sleep(250);
            var op = (IFileOperation)new FileOperation();
            var sink = new Sink();
            uint cookie = 0;
            try {
                op.Advise(sink, out cookie);
                Marshal.ThrowExceptionForHR((int)op.SetOperationFlags(0x0004 | 0x0010 | 0x0040 | 0x0400 | 0x00080000));
                Guid g = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
                foreach (string full in remaining) {
                    if (!File.Exists(full)) continue;
                    IShellItem item;
                    int hr = SHCreateItemFromParsingName(full, IntPtr.Zero, ref g, out item);
                    if (hr != 0) Marshal.ThrowExceptionForHR(hr);
                    try { Marshal.ThrowExceptionForHR((int)op.DeleteItem(item, IntPtr.Zero)); }
                    finally { Marshal.ReleaseComObject(item); }
                }
                uint phr = op.PerformOperations();
                bool aborted; op.GetAnyOperationsAborted(out aborted);

                var nextRemaining = new List<string>();
                foreach (string full in remaining) {
                    if (File.Exists(full)) nextRemaining.Add(full);
                }
                remaining = nextRemaining;
                if (remaining.Count == 0) return;

                lastHr = sink.LastErrHr != 0 ? sink.LastErrHr : phr;
                lastFile = !string.IsNullOrEmpty(sink.LastErrName) ? sink.LastErrName : Path.GetFileName(remaining[0]);
                bool transient = (lastHr == 0x80270027 || lastHr == 0x80070020 || lastHr == 0 || lastHr == 0x80270000);
                if (!transient) break;
            } finally {
                if (cookie != 0) try { op.Unadvise(cookie); } catch {}
                Marshal.ReleaseComObject(op);
            }
        }
        if (remaining.Count > 0) {
            throw new IOException(DescribeHr(lastHr, lastFile));
        }
    }
}
`;

const WIN_TRASH_CS_EXE = WIN_TRASH_CS_CLASS + `
public static class WinTrashMain {
    [STAThread]
    public static int Main(string[] args) {
        try {
            if (args.Length == 0) return 0;
            WinRecycleBin.MoveToRecycleBin(args);
            return 0;
        } catch (Exception ex) {
            while (ex.InnerException != null) ex = ex.InnerException;
            byte[] buf = Encoding.UTF8.GetBytes((ex.Message ?? ex.ToString()) + "\\n");
            using (var s = Console.OpenStandardError()) s.Write(buf, 0, buf.Length);
            return 1;
        }
    }
}
`;

const WIN_TRASH_PS = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$rawJson = $env:TRASH_FILES
if ([string]::IsNullOrWhiteSpace($rawJson)) { exit 0 }
$parsed = $rawJson | ConvertFrom-Json
$files = if ($parsed -is [System.Array]) { [string[]]$parsed } elseif ($null -ne $parsed) { @([string]$parsed) } else { @() }
if ($files.Count -eq 0) { exit 0 }
$csCode = @'
${WIN_TRASH_CS_CLASS}
'@
try {
    Add-Type -TypeDefinition $csCode -Language CSharp
    [WinRecycleBin]::MoveToRecycleBin($files)
    exit 0
} catch {
    $ex = $_.Exception
    while ($ex.InnerException) { $ex = $ex.InnerException }
    $msg = $ex.Message
    if ([string]::IsNullOrWhiteSpace($msg)) { $msg = $_.ToString() }
    [Console]::Error.WriteLine($msg)
    exit 1
}
`;
const WIN_TRASH_PS_B64 = IS_WIN ? Buffer.from(WIN_TRASH_PS, 'utf16le').toString('base64') : '';

function runCompiler(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, TMP: CACHE_DIR, TEMP: CACHE_DIR };
    const p = spawn(cmd, args, { windowsHide: true, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} reject(new Error('compile timeout')); }, timeoutMs);
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 2000) err = err.slice(-1000); });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => {
      clearTimeout(t);
      code === 0 ? resolve() : reject(new Error(err.trim() || `${cmd} exit ${code}`));
    });
  });
}

let winTrashBuildPromise = null;
/**
 * 仿照 macOS cache/rawdev：在 Windows 上首次自动用系统自带 csc.exe 把内联源码编译缓存到 cache/win-trash.exe（9.5 KB），
 * 省掉每次启动 PowerShell + Add-Type 的 1.2s 编译开销，删除耗时压到 ~140ms；失败则自动回退 PowerShell。
 */
async function ensureWinTrashBin() {
  if (!IS_WIN) return null;
  try {
    const [srcSt, binSt] = await Promise.all([fsp.stat(__filename), fsp.stat(WIN_TRASH_BIN).catch(() => null)]);
    if (binSt && binSt.size > 2048 && binSt.mtimeMs >= srcSt.mtimeMs) return WIN_TRASH_BIN;
  } catch {}
  if (winTrashBuildPromise) return winTrashBuildPromise;
  winTrashBuildPromise = (async () => {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    const tmpExe = WIN_TRASH_BIN + '.tmp.exe';
    const tmpCs = path.join(CACHE_DIR, 'win-trash.tmp.cs');
    try {
      const winRoot = process.env.SystemRoot || 'C:\\Windows';
      const cscCandidates = [
        path.join(winRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
        path.join(winRoot, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
      ];
      const csc = cscCandidates.find((p) => fs.existsSync(p));
      if (csc) {
        try {
          await fsp.writeFile(tmpCs, WIN_TRASH_CS_EXE, 'utf8');
          await runCompiler(csc, ['/nologo', '/optimize+', '/codepage:65001', '/target:exe', `/out:${tmpExe}`, tmpCs]);
          try { await fsp.unlink(WIN_TRASH_BIN); } catch {}
          await fsp.rename(tmpExe, WIN_TRASH_BIN);
          return WIN_TRASH_BIN;
        } catch {
          try { await fsp.unlink(tmpExe); } catch {}
        } finally {
          try { await fsp.unlink(tmpCs); } catch {}
        }
      }
      return null;
    } finally {
      winTrashBuildPromise = null;
    }
  })();
  return winTrashBuildPromise;
}

/** 把文件移入系统废纸篓 / 回收站（不永久删除） */
async function moveToTrash(absList) {
  if (!absList.length) return;
  let cmd, args, env = process.env;
  if (IS_MAC) {
    if (fs.existsSync('/usr/bin/trash')) {
      cmd = '/usr/bin/trash';
      args = absList;
    } else {
      cmd = 'osascript';
      args = [
        '-e', 'on run argv',
        '-e', 'repeat with p in argv',
        '-e', 'set f to POSIX file (p as text) as alias',
        '-e', 'tell application "Finder" to delete f',
        '-e', 'end repeat',
        '-e', 'end run',
        '--', ...absList,
      ];
    }
  } else if (IS_WIN) {
    const resolved = absList.map((f) => {
      try { return fs.realpathSync.native ? fs.realpathSync.native(f) : fs.realpathSync(f); } catch { return f; }
    });
    const bin = await ensureWinTrashBin();
    if (bin) {
      cmd = bin;
      args = resolved;
    } else {
      cmd = 'powershell';
      args = ['-NoProfile', '-STA', '-OutputFormat', 'Text', '-EncodedCommand', WIN_TRASH_PS_B64];
      env = { ...process.env, TRASH_FILES: JSON.stringify(resolved) };
    }
  } else {
    cmd = 'gio';
    args = ['trash', ...absList];
  }

  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString('utf8'); });
    p.on('error', (e) => reject(new Error(`无法移入废纸篓: ${e.message}`)));
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `移入废纸篓失败 (exit ${code})`));
    });
  });
}

module.exports = { moveToTrash, ensureWinTrashBin };
