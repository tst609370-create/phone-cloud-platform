import { describe, expect, it } from 'vitest';
import { getFileIconType } from '../FileIconUtils';

describe('getFileIconType', () => {
    it('returns folder for directories', () => {
        expect(getFileIconType('DCIM', true, false)).toBe('folder');
    });

    it('returns folder for directory even with file-like name', () => {
        expect(getFileIconType('photos.bak', true, false)).toBe('folder');
    });

    it('returns image for image extensions', () => {
        expect(getFileIconType('photo.jpg', false, false)).toBe('image');
        expect(getFileIconType('icon.PNG', false, false)).toBe('image');
        expect(getFileIconType('graphic.webp', false, false)).toBe('image');
    });

    it('returns video for video extensions', () => {
        expect(getFileIconType('movie.mp4', false, false)).toBe('video');
        expect(getFileIconType('clip.mkv', false, false)).toBe('video');
    });

    it('returns audio for audio extensions', () => {
        expect(getFileIconType('song.mp3', false, false)).toBe('audio');
        expect(getFileIconType('track.flac', false, false)).toBe('audio');
    });

    it('returns text for text/code extensions', () => {
        expect(getFileIconType('readme.txt', false, false)).toBe('text');
        expect(getFileIconType('config.json', false, false)).toBe('text');
        expect(getFileIconType('script.sh', false, false)).toBe('text');
    });

    it('returns file for unknown extensions', () => {
        expect(getFileIconType('data.bin', false, false)).toBe('file');
        expect(getFileIconType('archive.apk', false, false)).toBe('file');
    });

    it('returns file for files with no extension', () => {
        expect(getFileIconType('Makefile', false, false)).toBe('file');
    });

    it('handles case insensitively', () => {
        expect(getFileIconType('Photo.JPG', false, false)).toBe('image');
        expect(getFileIconType('VIDEO.MP4', false, false)).toBe('video');
    });
});
