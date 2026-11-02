/* Skitter — the creature, drawn with canvas primitives.
   Shared between the Electron renderer and the web demo (UMD).
   Local coordinate convention: origin = feet center, +y = toward the feet, +x = facing direction. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Creature = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const C = {
    fur: '#a8713f', furDark: '#7a4f2a', line: '#4a2d18', belly: '#e9cf9f',
    earIn: '#d9a28a', eyeWhite: '#fffaf0', pupil: '#1c1410', nose: '#3a2415',
    teeth: '#fff8e6', cheek: 'rgba(230,120,120,0.45)', paper: '#fbfaf5', paperLine: '#b9b4a8',
    paperEdge: '#8b857a', book: '#5d7bb3', bookPage: '#f3efe3',
    folderBack: '#d6ad55', folderFront: '#f1c86b', folderInner: '#a07d36', folderLine: '#8a6425',
    shadow: 'rgba(0,0,0,0.22)'
  };

  function ellipse(ctx, x, y, rx, ry, fill, stroke, lw) {
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 2; ctx.stroke(); }
  }
  function rrect(ctx, x, y, w, h, r, fill, stroke, lw) {
    ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1.5; ctx.stroke(); }
  }

  /* A sheet of paper, origin = center. lift animates a slight tilt while carrying. */
  function drawPaper(ctx, x, y, angle, scale) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(angle || 0); ctx.scale(scale || 1, scale || 1);
    rrect(ctx, -10, -13, 20, 26, 2, C.paper, C.paperEdge, 1.5);
    ctx.strokeStyle = C.paperLine; ctx.lineWidth = 1.5; ctx.lineCap = 'round';
    for (let i = 0; i < 4; i++) { const yy = -7 + i * 5; ctx.beginPath(); ctx.moveTo(-6, yy); ctx.lineTo(i === 3 ? 1 : 6, yy); ctx.stroke(); }
    // folded corner
    ctx.beginPath(); ctx.moveTo(4, -13); ctx.lineTo(10, -7); ctx.lineTo(4, -7); ctx.closePath();
    ctx.fillStyle = '#e8e4d8'; ctx.fill(); ctx.strokeStyle = C.paperEdge; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();
  }

  function drawBook(ctx, x, y) {
    ctx.save(); ctx.translate(x, y);
    rrect(ctx, -9, -6, 18, 12, 1.5, C.book, C.line, 1.5);
    ctx.fillStyle = C.bookPage; ctx.fillRect(-7, -4, 6, 8); ctx.fillRect(1, -4, 6, 8);
    ctx.restore();
  }

  /* The Skitter: a little yellow wall crawler. Dome body, one big eye, four legs with suction-cup feet,
     and a front claw that carries the file. Drawn in profile; origin = feet center, +x = facing.
     p: { facing:+1|-1, walk:phase|null, carrying, blink:0..1, pose, squash, lookDir:-1..1, armRaise:0..1, paperAngle, t } */
  const M = { line: '#2B2420', metal: '#5B6270', metalDark: '#3E4450', joint: '#8A93A3', cup: '#E4572E', eye: '#FBFAF5', pupil: '#1F2533', glow: '#7FF0E0', bodyDark: '#C99A0E', bodyLight: '#FFE586' };

  function stroke2(ctx, pts, color, w) {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.strokeStyle = M.line; ctx.lineWidth = w + 2.6; ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.stroke();
  }
  /* one leg: hip on the body, knee lifted outward, suction-cup foot on the ground */
  function leg(ctx, hipX, hipY, footX, lift, outward, color) {
    const kneeX = hipX + (footX - hipX) * 0.5, kneeY = hipY - 8 - lift * 0.6; // arched, like a spider's
    stroke2(ctx, [[hipX, hipY], [kneeX, kneeY], [footX, -1.5 - lift]], color, 3.4);
    ellipse(ctx, kneeX, kneeY, 2.2, 2.2, M.joint, M.line, 1.2);
    ellipse(ctx, footX, -1.2 - lift, 4.4, 1.9, M.cup, M.line, 1.2);
  }

  function drawGopher(ctx, p) {
    p = Object.assign({ body: '#F5C518', bodyDark: '#C99A0E', bodyLight: '#FFE586' }, p);
    const facing = p.facing || 1;
    const squash = p.squash == null ? 1 : p.squash;
    const t = p.t || 0;
    ctx.save();
    ctx.scale(facing * (2 - squash), squash);
    const walking = p.walk != null;
    const ph = walking ? p.walk : 0;
    const sit = p.pose === 'sit' || p.pose === 'read';
    const happy = p.pose === 'happy';
    const bob = walking ? Math.abs(Math.sin(ph)) * 1.2 : happy ? Math.abs(Math.sin(t * 9)) * 3 : (sit ? 0 : Math.sin(t * 2.2) * 0.5);
    const baseY = (sit ? -9 : -13) - bob;     // underside of the dome
    const domeTop = baseY - 25;
    const raise = p.armRaise == null ? (p.carrying ? 1 : 0) : p.armRaise;

    // four-legged gait: diagonal pairs move together
    const g = (o) => walking ? Math.sin(ph + o) : 0;
    const lift = (o) => walking ? Math.max(0, Math.cos(ph + o)) * 3 : 0;
    const spread = sit ? 3 : 0;

    // far legs (behind the body, darker metal)
    leg(ctx, -8, baseY - 5, -24 - spread + g(Math.PI) * 4, lift(Math.PI), -1, M.metalDark);
    leg(ctx, 8, baseY - 5, 22 + spread + g(0) * 4, lift(0), 1, M.metalDark);

    // dome body
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.25)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
    ctx.beginPath(); ctx.moveTo(-21, baseY); ctx.quadraticCurveTo(-21, domeTop, 0, domeTop); ctx.quadraticCurveTo(21, domeTop, 21, baseY); ctx.closePath();
    ctx.fillStyle = p.body || C.fur; ctx.fill(); ctx.restore();
    ctx.beginPath(); ctx.moveTo(-21, baseY); ctx.quadraticCurveTo(-21, domeTop, 0, domeTop); ctx.quadraticCurveTo(21, domeTop, 21, baseY); ctx.closePath();
    ctx.strokeStyle = M.line; ctx.lineWidth = 2.2; ctx.stroke();
    // highlight + base band
    ctx.beginPath(); ctx.moveTo(-14, baseY - 10); ctx.quadraticCurveTo(-12, domeTop + 5, -3, domeTop + 3);
    ctx.strokeStyle = p.bodyLight || M.bodyLight; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.stroke();
    rrect(ctx, -23, baseY - 2, 46, 7, 3.5, p.bodyDark || M.bodyDark, M.line, 1.8);
    ellipse(ctx, -16, baseY + 1.5, 1.1, 1.1, M.line, null); ellipse(ctx, 16, baseY + 1.5, 1.1, 1.1, M.line, null);
    // antenna
    ctx.strokeStyle = M.line; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.moveTo(-2, domeTop + 1); ctx.lineTo(-3, domeTop - 6); ctx.stroke();
    const glowPulse = 0.75 + Math.sin(t * 3) * 0.25;
    ctx.save(); ctx.globalAlpha = glowPulse; ellipse(ctx, -3, domeTop - 8, 2.4, 2.4, M.glow, M.line, 1.2); ctx.restore();

    // the eye: big, toward the front
    const ex = 7, ey = baseY - 13;
    const blink = p.blink || 0, look = p.lookDir || 0;
    if (happy) { // closed, smiling eye
      ctx.strokeStyle = M.line; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(ex, ey + 2, 5.5, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
    } else {
      ctx.save(); ctx.translate(ex, ey); ctx.scale(1, Math.max(0.1, 1 - blink));
      ellipse(ctx, 0, 0, 8, 8, M.eye, M.line, 1.8);
      ellipse(ctx, 1.8 + look * 2, 0.5, 4.2, 4.2, M.pupil, null);
      ellipse(ctx, 3.4 + look * 2, -1.4, 1.4, 1.4, '#fff', null);
      ctx.restore();
      if (p.pose === 'shrug') { ctx.strokeStyle = M.line; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.moveTo(ex - 6, ey - 11); ctx.lineTo(ex + 5, ey - 9.5); ctx.stroke(); }
    }

    // near legs (in front of the body)
    leg(ctx, -12, baseY - 3, -29 - spread + g(0) * 4, lift(0), -1, p.bodyDark || M.bodyDark);
    leg(ctx, 12, baseY - 3, 28 + spread + g(Math.PI) * 4, lift(Math.PI), 1, p.bodyDark || M.bodyDark);

    // front claw
    const sh = [16, baseY - 6];
    if (p.pose === 'read') {
      stroke2(ctx, [sh, [25, baseY - 2], [27, baseY - 11]], M.metal, 2.8);
      drawBook(ctx, 27, baseY - 15);
    } else if (p.pose === 'shrug') {
      stroke2(ctx, [sh, [27, baseY - 14], [30, baseY - 24]], M.metal, 2.8);
      ctx.strokeStyle = M.line; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(27, baseY - 26); ctx.lineTo(30, baseY - 24); ctx.lineTo(33, baseY - 27); ctx.stroke();
      ctx.fillStyle = M.line; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
      ctx.save(); ctx.scale(facing, 1); ctx.fillText('?', facing * 0, domeTop - 14 - Math.sin(t * 4) * 1.5); ctx.restore();
    } else if (raise > 0.01) {
      const a = raise;
      const elbow = [sh[0] + 10, sh[1] - 8 * a], hand = [sh[0] + 6 - 2 * a, sh[1] - 34 * a];
      stroke2(ctx, [sh, elbow, hand], M.metal, 2.8);
      ellipse(ctx, elbow[0], elbow[1], 2, 2, M.joint, M.line, 1.1);
      if (p.carrying) {
        const wob = walking ? Math.sin(ph) * 0.12 : Math.sin(t * 2.5) * 0.05;
        drawPaper(ctx, hand[0] - 2, hand[1] - 12 * a, (p.paperAngle || 0) + wob + 0.18, a);
      }
      ctx.strokeStyle = M.line; ctx.lineWidth = 2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(hand[0] - 3, hand[1] - 3); ctx.lineTo(hand[0], hand[1]); ctx.lineTo(hand[0] + 3, hand[1] - 3); ctx.stroke();
    } else if (happy) {
      const w = Math.sin(t * 10) * 4;
      stroke2(ctx, [sh, [27, baseY - 16], [28 + w, baseY - 28]], M.metal, 2.8);
    } else {
      const sw = walking ? Math.sin(ph + Math.PI) * 2 : 0;
      stroke2(ctx, [sh, [26, baseY - 2 + sw], [27, baseY + 6]], M.metal, 2.8);
      ctx.strokeStyle = M.line; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.moveTo(25, baseY + 8); ctx.lineTo(27, baseY + 6); ctx.lineTo(30, baseY + 8); ctx.stroke();
    }
    ctx.restore();
  }

  /* Folder, origin = bottom center. open 0..1 lifts the front flap; shake jitters. */
  function drawFolder(ctx, f) {
    const open = f.open || 0, sh = f.shake || 0;
    const jx = sh ? (Math.random() - 0.5) * 3 * sh : 0, jy = sh ? (Math.random() - 0.5) * 2 * sh : 0;
    ctx.save(); ctx.translate(jx, jy);
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.25)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 3;
    rrect(ctx, -36, -52, 72, 52, 4, C.folderBack, null);
    ctx.restore();
    rrect(ctx, -36, -52, 72, 52, 4, null, C.folderLine, 2);
    rrect(ctx, -36, -60, 26, 12, 3, C.folderBack, C.folderLine, 2);
    ctx.fillStyle = C.folderBack; ctx.fillRect(-34, -52, 22, 4);
    // interior
    ctx.fillStyle = C.folderInner; ctx.fillRect(-33, -49, 66, 42);
    ctx.restore();
  }
  function drawFolderFront(ctx, f) {
    const open = f.open || 0, sh = f.shake || 0;
    const jx = sh ? (Math.random() - 0.5) * 3 * sh : 0, jy = sh ? (Math.random() - 0.5) * 2 * sh : 0;
    ctx.save(); ctx.translate(jx, jy);
    // front flap: hinge at bottom, tilts forward (looks like it drops down) when open
    ctx.translate(0, 0); ctx.scale(1, 1 - open * 0.35);
    rrect(ctx, -36, -44, 72, 44, 4, C.folderFront, C.folderLine, 2);
    ctx.strokeStyle = 'rgba(138,100,37,0.5)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(-28, -30); ctx.lineTo(10, -30); ctx.moveTo(-28, -22); ctx.lineTo(20, -22); ctx.stroke();
    ctx.restore();
  }

  function drawPuff(ctx, x, y, r, alpha) {
    ctx.save(); ctx.globalAlpha = alpha;
    ellipse(ctx, x, y, r, r * 0.8, 'rgba(220,210,190,0.9)', null);
    ctx.restore();
  }
  function drawScrap(ctx, s) {
    ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(s.rot); ctx.globalAlpha = s.alpha;
    rrect(ctx, -5, -6, 10, 12, 1, C.paper, C.paperEdge, 1);
    ctx.restore();
  }
  function drawShadow(ctx, x, y, w) {
    ellipse(ctx, x, y, w, w * 0.28, C.shadow, null);
  }

  return { drawGopher, drawFolder, drawFolderFront, drawPaper, drawPuff, drawScrap, drawShadow, colors: C };
});
