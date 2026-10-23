import type { SoundClip, OnboardAnnouncement, AnnouncementDoorSide } from './types';

export function clipDuration(clip: SoundClip): number {
  return clip.durationS ?? (clip.range[1] - clip.range[0] - (clip.loopCrossfadeS ?? 0));
}

export function findOnboardAnnouncement(station: string, direction: 'DN' | 'UP', destination: string,
  side: AnnouncementDoorSide, catalog: readonly OnboardAnnouncement[] = []): OnboardAnnouncement | undefined {
  return catalog.find(announcement => announcement.station === station && announcement.direction === direction &&
    announcement.destination === destination && announcement.doorSide === side);
}
