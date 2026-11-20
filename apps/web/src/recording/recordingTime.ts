export function recordingTime(seconds: number, precise = false) {
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const pad = (value: number) => String(value).padStart(2, '0');
  const clock = (minutes >= 60 ? Math.floor(minutes / 60) + ':' + pad(minutes % 60) : String(minutes)) + ':' + pad(whole % 60);
  return precise ? clock + '.' + pad(Math.floor(seconds * 100 + 1e-7) % 100) : clock;
}
