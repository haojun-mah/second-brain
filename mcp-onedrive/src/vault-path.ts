export const OBSIDIAN_DRIVE_PREFIX = '/drive/root:/Obsidian';

export function vaultContentPath(userPath: string): string {
  return `/me/drive/root:/Obsidian/${userPath}:/content`;
}

export function vaultMetaPath(userPath: string): string {
  return `/me/drive/root:/Obsidian/${userPath}:`;
}

export function vaultChildrenPath(userPath: string, selectFields: string): string {
  return userPath === ''
    ? `/me/drive/root:/Obsidian:/children?${selectFields}`
    : `/me/drive/root:/Obsidian/${userPath}:/children?${selectFields}`;
}

export function drivePathToVaultRelative(drivePath: string, itemName: string): string {
  const relativePart = drivePath.slice(OBSIDIAN_DRIVE_PREFIX.length).replace(/^\//, '');
  return relativePart ? `${relativePart}/${itemName}` : itemName;
}
