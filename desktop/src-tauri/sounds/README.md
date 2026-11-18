# pacer-drop.caf

The bundled notification sound, played by macOS `UNNotificationSound`
(`UNNotificationSound::soundNamed("pacer-drop.caf")`) when the user's
`notificationSound` setting is `pacer` (the default). It is a short, low,
rounded "drop" tone.

Bundled location: `pacer.app/Contents/Resources/pacer-drop.caf`.

## Synthesis

The sound is original and synthesized mathematically — there is no recording
and no third-party license. It is generated as a WAV and converted to the
CAF format that `UNNotificationSound` expects, then checked in here. To
regenerate:

1. Write the drop with this recipe (Python with NumPy), 44100 Hz mono 16-bit:

   ```python
   import numpy as np, wave
   SR = 44100

   def drop(f0, f1, sweep, dur, decay, attack=0.006):
       t = np.arange(int(SR*dur)) / SR
       k = np.minimum(t/sweep, 1)
       freq = f0 * (f1/f0)**k
       phase = 2*np.pi*np.cumsum(freq)/SR
       return np.sin(phase) * np.minimum(1, t/attack) * np.exp(-t*decay)

   def lowpass(x, cutoff):
       a = np.exp(-2*np.pi*cutoff/SR); y = np.empty_like(x); acc = 0.0
       for i, v in enumerate(x):
           acc = (1-a)*v + a*acc; y[i] = acc
       return y

   sig = drop(250, 620, 0.05, 0.35, 12, attack=0.006)
   sig = np.concatenate([sig, np.zeros(int(SR*0.4) - len(sig))])  # pad to 0.4 s
   sig = lowpass(sig, 2600)
   sig = sig / np.max(np.abs(sig)) * 0.18
   fade = int(SR*0.06); sig[-fade:] *= np.linspace(1, 0, fade)
   with wave.open('pacer-drop.wav', 'wb') as w:
       w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
       w.writeframes((sig*32767).astype(np.int16).tobytes())
   ```

2. Convert the WAV to CAF with `afconvert` (bundled with macOS):

   ```
   afconvert -f caff -d LEI16 pacer-drop.wav pacer-drop.caf
   ```

3. Replace `pacer-drop.caf` in this directory and rebuild the bundle.
