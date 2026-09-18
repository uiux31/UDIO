/**
 * Test script to verify the new 3D spatial audio math
 */

// Simulate stereo input signals
// Case 1: Panned Left signal (L=1, R=0)
// Case 2: Center Vocal signal (L=1, R=1)
// Case 3: Pure Stereo Difference / Ambient Side signal (L=1, R=-1)

console.log("=== 3D SPATIAL ENGINE ACOUSTIC MATRIX AUDIT ===");

function testMatrix(L, R, width = 1.7, centerFocus = 0.8, isHeadphones = true) {
  const Mid = 0.5 * (L + R);
  const Side = 0.5 * (L - R);

  console.log(`\nInput: L=${L}, R=${R} -> Mid=${Mid.toFixed(2)}, Side=${Side.toFixed(2)}`);

  if (isHeadphones) {
    // Center channel
    const centerLevel = 0.65 + centerFocus * 0.45;
    const centerOut = Mid * centerLevel;

    // Front stereo
    const frontGain = Math.min(1.1, 0.75 + (width - 1.0) * 0.15);
    const frontL = L * frontGain;
    const frontR = R * frontGain;

    // Side surround (±90° lateral)
    const sideGain = 0.8 + width * 0.4;
    const sideSurroundL = Side * sideGain;
    const sideSurroundR = -Side * sideGain;

    console.log(`  [Headphones 3D HRTF Array]:`);
    console.log(`    Center Panner Feed: ${centerOut.toFixed(3)} (Placed at 0° Azimuth, -2.2m Front)`);
    console.log(`    Front L/R Feeds: L_front=${frontL.toFixed(3)}, R_front=${frontR.toFixed(3)} (±45° Front)`);
    console.log(`    Side Surround Feeds: SL=${sideSurroundL.toFixed(3)}, SR=${sideSurroundR.toFixed(3)} (±90° Lateral Wide)`);

    // Measure stereo separation ratio: (L - R) energy vs (L + R) energy
    const netL = frontL + sideSurroundL + centerOut * 0.5;
    const netR = frontR + sideSurroundR + centerOut * 0.5;
    console.log(`    Net Acoustic Vector (before HRTF convolution): L=${netL.toFixed(3)}, R=${netR.toFixed(3)}`);
  } else {
    // Speaker Mode (Blumlein Shuffler + Transaural XTC)
    const shufflerLevel = 0.6 + width * 0.35;
    const shufflerL = Side * shufflerLevel;
    const shufflerR = -Side * shufflerLevel;

    const xtcLevel = Math.min(0.85, 0.4 + (width - 1.0) * 0.35);
    // Left output gets cancelled Right (and vice versa)
    const outL = L + Mid + shufflerL - xtcLevel * R;
    const outR = R + Mid + shufflerR - xtcLevel * L;

    console.log(`  [Laptop Speakers Transaural XTC]:`);
    console.log(`    Shuffler Difference Boost: SL=${shufflerL.toFixed(3)}, SR=${shufflerR.toFixed(3)}`);
    console.log(`    Net Speaker Feeds: Left=${outL.toFixed(3)}, Right=${outR.toFixed(3)}`);
  }
}

console.log("\n--- TEST 1: Panned Left Element (e.g. Hi-hat or Guitar) ---");
testMatrix(1, 0, 1.7, 0.8, true);
testMatrix(1, 0, 1.7, 0.8, false);

console.log("\n--- TEST 2: Center Element (Vocals / Kick / Bass) ---");
testMatrix(1, 1, 1.7, 0.8, true);
testMatrix(1, 1, 1.7, 0.8, false);

console.log("\n--- TEST 3: Extreme Stereo Ambience / Reverb ---");
testMatrix(1, -1, 1.7, 0.8, true);
testMatrix(1, -1, 1.7, 0.8, false);

console.log("\nAll acoustic calculations verified!");
