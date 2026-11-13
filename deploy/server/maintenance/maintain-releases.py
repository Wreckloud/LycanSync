#!/usr/bin/env python3
"""核对并清理客户端发布副本；默认只预览，不操作运行数据。"""
import argparse
import hashlib
import json
import os
import re
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

VERSION = r'(\d+\.\d+\.\d+)'
INSTALLER = re.compile(r'LycanSync-' + VERSION + r'-windows-x64-setup\.exe$')
ARTIFACT = re.compile(r'LycanSync-' + VERSION + r'-(?:windows-x64-setup\.exe(?:\.blockmap)?|obs-source\.tar\.gz|THIRD-PARTY-NOTICES\.txt|release\.json)$')


def maintain(root, apply=False):
    root = root.resolve(strict=True)
    for name in ['downloads', 'incoming', 'releases', 'backups', 'maintenance']:
        directory = root / name
        if directory.is_symlink() or directory.exists() and not directory.is_dir():
            raise ValueError('发布目录不能是符号链接或普通文件')
    downloads = root / 'downloads'
    if downloads.is_symlink() or not downloads.is_dir():
        raise ValueError('下载目录必须是项目内的真实目录')
    manifest = (downloads / 'latest.yml').read_bytes()
    match = re.search(rb'^version: (\d+\.\d+\.\d+)\s*$', manifest, re.M)
    if not match:
        raise ValueError('无法确认当前发布版本')
    current = match[1].decode()
    version_key = lambda value: tuple(map(int, value.split('.')))
    installers = {m[1]: p for p in downloads.iterdir() if not p.is_symlink() and p.is_file() and (m := INSTALLER.fullmatch(p.name))}
    versions = sorted((v for v in installers if version_key(v) <= version_key(current)), key=version_key)
    if not versions or versions[-1] != current:
        raise ValueError('当前版本的安装程序缺失')
    keep = versions[-1:]
    hashes = {}

    def digest(file):
        if file.is_symlink() or root not in file.resolve(strict=True).parents:
            raise ValueError('拒绝处理符号链接或项目外文件')
        stat = file.stat()
        key = (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)
        if key not in hashes:
            checksum = hashlib.sha256()
            with file.open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    checksum.update(chunk)
            hashes[key] = checksum.hexdigest()
        return hashes[key]

    # 删除前先确认当前版完整载荷及两个下载别名，历史版本不作为回滚材料保留。
    for version in keep:
        record = json.loads((downloads / f'LycanSync-{version}-release.json').read_text())
        expected = {f'LycanSync-{version}-{suffix}' for suffix in [
            'windows-x64-setup.exe', 'windows-x64-setup.exe.blockmap',
            'obs-source.tar.gz', 'THIRD-PARTY-NOTICES.txt']}
        if record['version'] != version or {f['name'] for f in record['files']} != expected | {'latest.yml'}:
            raise ValueError('保留版本的分发记录不完整')
        for entry in record['files']:
            if entry['name'] == 'latest.yml' and version != current:
                continue
            file = downloads / entry['name']
            if file.stat().st_size != entry['bytes'] or digest(file) != entry['sha256']:
                raise ValueError(f'保留载荷校验失败：{file.name}')
    for suffix in ['.exe', '.exe.blockmap']:
        if digest(downloads / f'LycanSync-setup{suffix}') != digest(downloads / f'LycanSync-{current}-windows-x64-setup{suffix}'):
            raise ValueError('下载别名与当前版本不一致')

    actions = {}
    retired = {v: p for v, p in installers.items() if version_key(v) < version_key(keep[0])}
    known_installers = {}
    for file in installers.values():
        known_installers.setdefault(file.stat().st_size, []).append(file)
    roots = [root / 'releases', root / 'incoming', root / 'download-backups']
    roots += [p for p in root.iterdir() if p.is_dir() and p.name.startswith('incoming-')]
    roots += [p for p in downloads.iterdir() if p.is_dir() and p.name.startswith('incoming-')]
    for directory in roots:
        if not directory.exists() or directory.is_symlink():
            continue
        for parent, dirs, files in os.walk(directory, followlinks=False):
            dirs[:] = [name for name in dirs if not (Path(parent) / name).is_symlink()]
            for name in files:
                file = Path(parent) / name
                if file.is_symlink():
                    continue
                canonical = downloads / name
                if ARTIFACT.fullmatch(name) and canonical.is_file():
                    if file.stat().st_size == canonical.stat().st_size and digest(file) == digest(canonical):
                        actions[file] = 'duplicate'
                elif name.endswith('.exe'):
                    # 历史回退别名只有与已发布安装包逐字节相符时才清除。
                    for candidate in known_installers.get(file.stat().st_size, []):
                        if digest(file) == digest(candidate):
                            actions[file] = 'duplicate-installer'
                            break
    for file in retired.values():
        actions[file] = 'retired-installer'
    for file in downloads.iterdir():
        match = ARTIFACT.fullmatch(file.name)
        if file.is_file() and not file.is_symlink() and match and version_key(match[1]) < version_key(current):
            actions[file] = 'retired-release-artifact'
    cutoff = (datetime.now(timezone.utc) - timedelta(days=3)).timestamp()
    maintenance = root / 'maintenance'
    if maintenance.is_dir():
        for file in maintenance.iterdir():
            # JSON/TXT 也可能是维护配置或说明，只自动清理日志和本工具生成的报告。
            report = re.fullmatch(r'release-cleanup-\d{8}T\d{6}Z\.json', file.name)
            if file.is_file() and not file.is_symlink() and (file.suffix == '.log' or report) and file.stat().st_mtime < cutoff:
                actions[file] = 'expired-maintenance-report'
    plan = [{'path': str(p.relative_to(root)), 'reason': reason, 'bytes': p.stat().st_size,
             'inode': p.stat().st_ino, 'modifiedNs': p.stat().st_mtime_ns} for p, reason in sorted(actions.items())]
    result = {'current': current, 'keepInstallers': keep, 'removeFiles': len(plan),
              'logicalBytes': sum(row['bytes'] for row in plan), 'applied': apply}
    if not apply:
        return result, plan
    if (downloads / 'latest.yml').read_bytes() != manifest:
        raise ValueError('更新入口已变化，停止清理')
    maintenance = root / 'maintenance'
    maintenance.mkdir(mode=0o700, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    report = maintenance / f'release-cleanup-{stamp}.json'
    report.write_text(json.dumps({'summary': result, 'files': plan}, indent=2) + '\n')
    report.chmod(0o600)
    free_before = shutil.disk_usage(root).free
    for row in plan:
        file = root / row['path']
        stat = file.stat()
        if stat.st_ino != row['inode'] or stat.st_size != row['bytes'] or stat.st_mtime_ns != row['modifiedNs']:
            raise ValueError(f'待清理文件发生变化：{row["path"]}')
        file.unlink()
    # 只归并已盘点的上传目录；运行配置与 Docker 挂载路径保持原位。
    incoming = root / 'incoming'
    incoming.mkdir(mode=0o700, exist_ok=True)
    incoming.chmod(0o700)
    legacy = incoming / 'legacy'
    legacy.mkdir(mode=0o700, exist_ok=True)
    moves = [p for p in root.iterdir() if p.is_dir() and p.name.startswith('incoming-')]
    moves += [p for p in downloads.iterdir() if p.is_dir() and p.name.startswith('incoming-')]
    for source in moves:
        if source.is_symlink() or (legacy / source.name).exists():
            raise ValueError('旧上传目录存在链接或命名冲突')
        source.rename(legacy / source.name)
    releases = root / 'releases'
    releases.mkdir(mode=0o700, exist_ok=True)
    for source in list(incoming.iterdir()):
        match = re.fullmatch(r'(?:client-)?' + VERSION + r'(?:-[0-9a-f]+)?', source.name)
        if source.is_dir() and not source.is_symlink() and match and not (releases / match[1]).exists():
            source.rename(releases / match[1])
    backups = root / 'backups'
    backups.mkdir(mode=0o700, exist_ok=True)
    if (root / 'download-backups').is_dir() and not (backups / 'client-legacy').exists():
        (root / 'download-backups').rename(backups / 'client-legacy')
    old_api = root / 'api-before-entry-ui-20261011.jar'
    if old_api.is_file() and not old_api.is_symlink() and not (backups / old_api.name).exists():
        old_api.rename(backups / old_api.name)
    result['freeBytesAfter'] = shutil.disk_usage(root).free
    result['freedBytes'] = result['freeBytesAfter'] - free_before
    result['report'] = str(report.relative_to(root))
    report.write_text(json.dumps({'summary': result, 'files': plan}, indent=2) + '\n')
    return result, plan


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    result, _ = maintain(args.root, args.apply)
    print(json.dumps(result))
