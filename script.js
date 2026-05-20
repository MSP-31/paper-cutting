const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const resetButton = document.getElementById("resetButton");
const cutButton = document.getElementById("cutButton");
const tearButton = document.getElementById("tearButton");
const grabButton = document.getElementById("grabButton");
const pinButton = document.getElementById("pinButton");
const toggleMenuButton = document.getElementById("toggleMenuButton");
const toolbar = document.querySelector(".toolbar");

let bodies = [];
let cutLine = null;
let tearPath = null;
let interactionMode = "cut";
let selectedBody = null;
let isDragging = false;
let dragStart = null;
let dragStartPoints = null;
let lastDrag = {x: 0, y: 0, time: 0};
let menuCollapsed = false;
let lastTime = 0;
const gravity = 1800; // px/s^2
const groundY = 0;
const floorHeight = 28;
const globalDamping = 0.99;

console.log("script.js loaded");

function setInteractionMode(mode) {
    interactionMode = mode;
    selectedBody = null;
    isDragging = false;
    cutButton.classList.toggle("active", mode === "cut");
    grabButton.classList.toggle("active", mode === "grab");
    pinButton.classList.toggle("active", mode === "pin");
    if (typeof tearButton !== "undefined" && tearButton) tearButton.classList.toggle("active", mode === "tear");
}

function setToolbarCollapsed(collapsed) {
    toolbar.classList.toggle("collapsed", collapsed);
    toggleMenuButton.textContent = collapsed ? "▶" : "◀";
}

function pinBody(body, point) {
    if (!body) return;
    body.pinned = true;
    // store as edge index + t (0..1) so pin moves with polygon vertices
    const edge = findClosestEdge(body.points, point);
    body.pinEdge = edge.index;
    body.pinT = edge.t;
    body.vx = 0;
    body.vy = 0;
    body.angularVelocity = 0;
}

function findClosestEdge(points, point) {
    let best = {index: 0, t: 0, dist: Infinity};
    for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        const vx = b.x - a.x;
        const vy = b.y - a.y;
        const len2 = vx * vx + vy * vy;
        let t = 0;
        if (len2 > 1e-6) t = ((point.x - a.x) * vx + (point.y - a.y) * vy) / len2;
        if (t < 0) t = 0;
        if (t > 1) t = 1;
        const px = a.x + vx * t;
        const py = a.y + vy * t;
        const dx = point.x - px;
        const dy = point.y - py;
        const dist = dx * dx + dy * dy;
        if (dist < best.dist) best = {index: i, t, dist};
    }
    return best;
}

function computePinWorld(body) {
    if (body.pinEdge === undefined || body.pinEdge === null) return null;
    const i = body.pinEdge;
    const a = body.points[i];
    const b = body.points[(i + 1) % body.points.length];
    const t = body.pinT || 0;
    return {x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t};
}

function performTear(path) {
    if (!path || path.length < 2) return;
    for (let s = 0; s < path.length - 1; s++) {
        const line = {x1: path[s].x, y1: path[s].y, x2: path[s + 1].x, y2: path[s + 1].y};
        const lineLen = Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
        if (lineLen < 6) continue;
        for (let i = 0; i < bodies.length; i++) {
            const body = bodies[i];
            if (lineIntersectionCount(body.points, line) < 2) continue;
            if (!intersectsPolygon(body.points, line)) continue;
            const pieces = cutBody(body, line);
            if (pieces) {
                bodies.splice(i, 1, pieces[0], pieces[1]);
                break;
            }
        }
    }
}

function polygonSignedArea(points) {
    let a = 0;
    for (let i = 0; i < points.length; i++) {
        const j = (i + 1) % points.length;
        a += points[i].x * points[j].y - points[j].x * points[i].y;
    }
    return a / 2;
}

function sutherlandHodgman(subject, clip) {
    if (!subject || subject.length === 0) return [];
    let output = subject.slice();
    const clipArea = polygonSignedArea(clip);
    const clipSign = clipArea >= 0 ? 1 : -1;

    for (let i = 0; i < clip.length; i++) {
        const a = clip[i];
        const b = clip[(i + 1) % clip.length];
        const input = output.slice();
        output = [];
        if (input.length === 0) break;
        for (let j = 0; j < input.length; j++) {
            const cur = input[j];
            const prev = input[(j - 1 + input.length) % input.length];
            const curInside = clipSign * lineSide(cur, {x1: a.x, y1: a.y, x2: b.x, y2: b.y}) >= 0;
            const prevInside = clipSign * lineSide(prev, {x1: a.x, y1: a.y, x2: b.x, y2: b.y}) >= 0;
            if (curInside) {
                if (!prevInside) {
                    const inter = segmentIntersection(prev, cur, {x1: a.x, y1: a.y, x2: b.x, y2: b.y});
                    if (inter) output.push(inter);
                }
                output.push(cur);
            } else if (prevInside) {
                const inter = segmentIntersection(prev, cur, {x1: a.x, y1: a.y, x2: b.x, y2: b.y});
                if (inter) output.push(inter);
            }
        }
    }
    return output;
}

function clipOutside(subject, clip) {
    if (!subject || subject.length === 0) return [];
    let output = subject.slice();
    const clipArea = polygonSignedArea(clip);
    const clipSign = clipArea >= 0 ? 1 : -1;

    for (let i = 0; i < clip.length; i++) {
        const a = clip[i];
        const b = clip[(i + 1) % clip.length];
        const input = output.slice();
        output = [];
        if (input.length === 0) break;
        for (let j = 0; j < input.length; j++) {
            const cur = input[j];
            const prev = input[(j - 1 + input.length) % input.length];
            const curInside = clipSign * lineSide(cur, {x1: a.x, y1: a.y, x2: b.x, y2: b.y}) >= 0;
            const prevInside = clipSign * lineSide(prev, {x1: a.x, y1: a.y, x2: b.x, y2: b.y}) >= 0;
            if (!curInside) {
                if (prevInside) {
                    const inter = segmentIntersection(prev, cur, {x1: a.x, y1: a.y, x2: b.x, y2: b.y});
                    if (inter) output.push(inter);
                }
                output.push(cur);
            } else if (!prevInside) {
                const inter = segmentIntersection(prev, cur, {x1: a.x, y1: a.y, x2: b.x, y2: b.y});
                if (inter) output.push(inter);
            }
        }
    }
    return output;
}

function isPointInPolygon(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].x,
            yi = polygon[i].y;
        const xj = polygon[j].x,
            yj = polygon[j].y;
        const intersect = yi > point.y !== yj > point.y && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
        if (intersect) inside = !inside;
    }
    return inside;
}

function getBodyUnderPoint(point) {
    for (let i = bodies.length - 1; i >= 0; i--) {
        if (isPointInPolygon(point, bodies[i].points)) {
            return bodies[i];
        }
    }
    return null;
}

function togglePin(body) {
    if (!body) return;
    body.pinned = !body.pinned;
    body.vx = 0;
    body.vy = 0;
    body.angularVelocity = 0;
    if (!body.pinned) {
        delete body.pinEdge;
        delete body.pinT;
    }
}

function translateBody(body, dx, dy) {
    body.points = body.points.map((point) => ({x: point.x + dx, y: point.y + dy}));
}

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    requestAnimationFrame(draw);
}

function makePaperBody() {
    const width = 300;
    const height = 380;
    const centerX = canvas.width / 2;
    const centerY = canvas.height * 0.25;
    const points = [
        {x: centerX - width / 2, y: centerY - height / 2},
        {x: centerX + width / 2, y: centerY - height / 2},
        {x: centerX + width / 2, y: centerY + height / 2},
        {x: centerX - width / 2, y: centerY + height / 2},
    ];

    return {
        points,
        vx: 0,
        vy: 0,
        angularVelocity: 0,
        color: "#f9f2d6",
        rotation: 0,
        pinned: false,
        isGrabbed: false,
    };
}

function resetScene() {
    bodies = [makePaperBody()];
    cutLine = null;
    selectedBody = null;
    isDragging = false;
    setInteractionMode("cut");
}

function getMousePosition(event) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
    };
}

function lineSide(point, line) {
    return (line.x2 - line.x1) * (point.y - line.y1) - (line.y2 - line.y1) * (point.x - line.x1);
}

function segmentIntersection(p1, p2, line) {
    const x1 = p1.x;
    const y1 = p1.y;
    const x2 = p2.x;
    const y2 = p2.y;
    const x3 = line.x1;
    const y3 = line.y1;
    const x4 = line.x2;
    const y4 = line.y2;
    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(denom) < 1e-6) return null;
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
    const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
        return {
            x: x1 + t * (x2 - x1),
            y: y1 + t * (y2 - y1),
        };
    }
    return null;
}

function clipPolygon(points, line) {
    const left = [];
    const right = [];
    for (let i = 0; i < points.length; i++) {
        const current = points[i];
        const next = points[(i + 1) % points.length];
        const currentSide = lineSide(current, line);
        const nextSide = lineSide(next, line);
        if (currentSide >= 0) left.push(current);
        if (currentSide <= 0) right.push(current);
        if (currentSide * nextSide < 0) {
            const intersection = segmentIntersection(current, next, line);
            if (intersection) {
                left.push(intersection);
                right.push(intersection);
            }
        }
    }
    return [left, right];
}

function polygonCentroid(points) {
    let x = 0;
    let y = 0;
    let area = 0;
    for (let i = 0; i < points.length; i++) {
        const j = (i + 1) % points.length;
        const cross = points[i].x * points[j].y - points[j].x * points[i].y;
        area += cross;
        x += (points[i].x + points[j].x) * cross;
        y += (points[i].y + points[j].y) * cross;
    }
    area *= 0.5;
    if (Math.abs(area) < 1e-6) return {x: points[0].x, y: points[0].y};
    return {x: x / (6 * area), y: y / (6 * area)};
}

function polygonArea(points) {
    let area = 0;
    for (let i = 0; i < points.length; i++) {
        const j = (i + 1) % points.length;
        area += points[i].x * points[j].y - points[j].x * points[i].y;
    }
    return Math.abs(area) / 2;
}

function cutBody(body, line) {
    const [first, second] = clipPolygon(body.points, line);
    if (first.length < 3 || second.length < 3) return null;
    if (polygonArea(first) < 1000 || polygonArea(second) < 1000) return null;
    const pinnedPoint = body.pinned ? computePinWorld(body) : null;
    const firstPinned = pinnedPoint && isPointInPolygon(pinnedPoint, first);
    const secondPinned = pinnedPoint && isPointInPolygon(pinnedPoint, second);

    let firstPinEdge, firstPinT;
    if (firstPinned) {
        const e = findClosestEdge(first, pinnedPoint);
        firstPinEdge = e.index;
        firstPinT = e.t;
    }
    let secondPinEdge, secondPinT;
    if (secondPinned) {
        const e2 = findClosestEdge(second, pinnedPoint);
        secondPinEdge = e2.index;
        secondPinT = e2.t;
    }

    return [
        {
            points: first,
            vx: body.vx - 80,
            vy: body.vy + 20,
            angularVelocity: body.angularVelocity + 0.8,
            color: body.color,
            rotation: body.rotation,
            pinned: firstPinned,
            pinEdge: firstPinEdge,
            pinT: firstPinT,
            isGrabbed: false,
        },
        {
            points: second,
            vx: body.vx + 80,
            vy: body.vy + 20,
            angularVelocity: body.angularVelocity - 0.8,
            color: body.color,
            rotation: body.rotation,
            pinned: secondPinned,
            pinEdge: secondPinEdge,
            pinT: secondPinT,
            isGrabbed: false,
        },
    ];
}

function distanceSquared(a, b) {
    return (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);
}

function intersectsPolygon(points, line) {
    let positive = false;
    let negative = false;
    for (const point of points) {
        const side = lineSide(point, line);
        if (side > 0) positive = true;
        if (side < 0) negative = true;
        if (positive && negative) return true;
    }
    for (let i = 0; i < points.length; i++) {
        const next = points[(i + 1) % points.length];
        if (segmentIntersection(points[i], next, line)) return true;
    }
    return false;
}

function lineIntersectionCount(points, line) {
    let count = 0;
    for (let i = 0; i < points.length; i++) {
        const next = points[(i + 1) % points.length];
        if (segmentIntersection(points[i], next, line)) count += 1;
    }
    return count;
}

function handleCut() {
    if (!cutLine) return;
    const lineLength = Math.hypot(cutLine.x2 - cutLine.x1, cutLine.y2 - cutLine.y1);
    if (lineLength < 10) {
        cutLine = null;
        return;
    }
    for (let i = 0; i < bodies.length; i++) {
        const body = bodies[i];
        if (lineIntersectionCount(body.points, cutLine) < 2) continue;
        if (!intersectsPolygon(body.points, cutLine)) continue;
        const pieces = cutBody(body, cutLine);
        if (pieces) {
            bodies.splice(i, 1, pieces[0], pieces[1]);
            break;
        }
    }
    cutLine = null;
}

function updateBodies(deltaTime) {
    bodies.forEach((body) => {
        if (body.pinned || body.isGrabbed) return;
        body.vy += gravity * deltaTime;
        body.vx *= globalDamping;
        body.vy *= globalDamping;
        const rotationChange = body.angularVelocity * deltaTime;
        const centroid = polygonCentroid(body.points);
        const cos = Math.cos(rotationChange);
        const sin = Math.sin(rotationChange);
        body.points = body.points.map((point) => {
            const dx = point.x - centroid.x;
            const dy = point.y - centroid.y;
            return {
                x: centroid.x + dx * cos - dy * sin + body.vx * deltaTime,
                y: centroid.y + dx * sin + dy * cos + body.vy * deltaTime,
            };
        });
        body.angularVelocity *= 0.998;

        let maxY = -Infinity;
        body.points.forEach((point) => {
            if (point.y > maxY) maxY = point.y;
        });
        if (maxY > canvas.height - floorHeight) {
            const correction = maxY - (canvas.height - floorHeight);
            body.points = body.points.map((point) => ({x: point.x, y: point.y - correction}));
            body.vy *= -0.45;
            body.vx *= 0.95;
            body.angularVelocity *= 0.6;
        }
    });
}

function drawBody(body) {
    ctx.save();
    ctx.beginPath();
    const first = body.points[0];
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < body.points.length; i++) {
        ctx.lineTo(body.points[i].x, body.points[i].y);
    }
    ctx.closePath();
    ctx.fillStyle = body.color;
    ctx.fill();
    ctx.strokeStyle = selectedBody === body ? "rgba(255, 255, 255, 0.95)" : "rgba(28, 45, 76, 0.8)";
    ctx.lineWidth = selectedBody === body ? 4 : 2;
    ctx.stroke();

    if (body.pinned) {
        const pinPos = computePinWorld(body) || polygonCentroid(body.points);
        ctx.fillStyle = "#e84c3d";
        ctx.beginPath();
        ctx.arc(pinPos.x, pinPos.y, 7, 0, Math.PI * 2);
        ctx.fill();
        // pin head highlight
        ctx.fillStyle = "#fff6f6";
        ctx.beginPath();
        ctx.arc(pinPos.x - 2, pinPos.y - 2, 2.5, 0, Math.PI * 2);
        ctx.fill();
        // pin shaft
        ctx.strokeStyle = "#b73a2d";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(pinPos.x, pinPos.y + 6);
        ctx.lineTo(pinPos.x, pinPos.y + 18);
        ctx.stroke();
    }

    ctx.restore();
}

function drawFloor() {
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.04)";
    ctx.fillRect(0, canvas.height - floorHeight, canvas.width, floorHeight);
    ctx.fillStyle = "rgba(255,255,255,0.14)";
    ctx.fillRect(0, canvas.height - floorHeight, canvas.width, 2);
    ctx.restore();
}

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(11, 24, 40, 0.95)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawFloor();
    bodies.forEach(drawBody);
    if (isDragging && cutLine) {
        ctx.save();
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineWidth = 4;
        ctx.setLineDash([12, 10]);
        ctx.beginPath();
        ctx.moveTo(cutLine.x1, cutLine.y1);
        ctx.lineTo(cutLine.x2, cutLine.y2);
        ctx.stroke();
        ctx.restore();
    }
    if (tearPath && tearPath.length > 1) {
        ctx.save();
        ctx.strokeStyle = "rgba(255,200,200,0.9)";
        ctx.lineWidth = 3;
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.moveTo(tearPath[0].x, tearPath[0].y);
        for (let i = 1; i < tearPath.length; i++) ctx.lineTo(tearPath[i].x, tearPath[i].y);
        ctx.stroke();
        ctx.restore();
    }
}

function animate(timestamp) {
    const deltaTime = Math.min((timestamp - lastTime) / 1000, 0.033);
    lastTime = timestamp;
    updateBodies(deltaTime);
    draw();
    requestAnimationFrame(animate);
}

canvas.addEventListener("mousedown", (event) => {
    const pos = getMousePosition(event);

    if (interactionMode === "pin") {
        const body = getBodyUnderPoint(pos);
        if (body) {
            if (body.pinned) {
                togglePin(body);
            } else {
                pinBody(body, pos);
            }
        }
        return;
    }

    if (interactionMode === "grab") {
        const body = getBodyUnderPoint(pos);
        if (body) {
            selectedBody = body;
            isDragging = true;
            body.isGrabbed = true;
            dragStart = pos;
            dragStartPoints = body.points.map((point) => ({x: point.x, y: point.y}));
            lastDrag = {x: pos.x, y: pos.y, time: performance.now(), vx: 0, vy: 0};
        }
        return;
    }

    if (interactionMode === "cut") {
        isDragging = true;
        cutLine = {x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y};
        return;
    }

    if (interactionMode === "tear") {
        isDragging = true;
        tearPath = [pos];
        return;
    }
});

canvas.addEventListener("mousemove", (event) => {
    const pos = getMousePosition(event);

    if (interactionMode === "grab" && isDragging && selectedBody) {
        const dx = pos.x - dragStart.x;
        const dy = pos.y - dragStart.y;
        selectedBody.points = dragStartPoints.map((point) => ({x: point.x + dx, y: point.y + dy}));
        selectedBody.vx = 0;
        selectedBody.vy = 0;
        selectedBody.angularVelocity = 0;

        const now = performance.now();
        const dt = (now - lastDrag.time) / 1000;
        if (dt > 0) {
            lastDrag.vx = (pos.x - lastDrag.x) / dt;
            lastDrag.vy = (pos.y - lastDrag.y) / dt;
            lastDrag = {x: pos.x, y: pos.y, time: now, vx: lastDrag.vx, vy: lastDrag.vy};
        }
        return;
    }

    if (interactionMode === "cut" && isDragging && cutLine) {
        cutLine.x2 = pos.x;
        cutLine.y2 = pos.y;
        return;
    }

    if (interactionMode === "tear" && isDragging && tearPath) {
        const last = tearPath[tearPath.length - 1];
        const dx = pos.x - last.x;
        const dy = pos.y - last.y;
        if (dx * dx + dy * dy > 16) {
            tearPath.push(pos);
        }
        return;
    }
});

canvas.addEventListener("mouseup", () => {
    if (interactionMode === "grab") {
        if (selectedBody) {
            selectedBody.vx = lastDrag.vx || 0;
            selectedBody.vy = lastDrag.vy || 0;
            selectedBody.isGrabbed = false;
        }
        selectedBody = null;
        isDragging = false;
        return;
    }

    if (interactionMode === "cut" && isDragging) {
        isDragging = false;
        handleCut();
    }
    if (interactionMode === "tear" && isDragging) {
        isDragging = false;
        // if the path closes, treat it as a closed cut polygon
        if (tearPath && tearPath.length > 2) {
            const first = tearPath[0];
            const last = tearPath[tearPath.length - 1];
            const dx = first.x - last.x;
            const dy = first.y - last.y;
            const dist2 = dx * dx + dy * dy;
            const closeThreshold = 20 * 20; // px^2
            if (dist2 <= closeThreshold) {
                // closed polygon clip
                const clipPoly = tearPath.slice();
                // try to cut each body by polygon
                for (let i = 0; i < bodies.length; i++) {
                    const body = bodies[i];
                    const inside = sutherlandHodgman(body.points, clipPoly);
                    if (!inside || inside.length < 3) continue;
                    if (polygonArea(inside) < 100) continue;
                    const outside = clipOutside(body.points, clipPoly);
                    if (!outside || outside.length < 3 || polygonArea(outside) < 100) continue;

                    // determine pin mapping
                    const pinnedPoint = body.pinned ? computePinWorld(body) : null;
                    let insidePinned = false;
                    let outsidePinned = false;
                    if (pinnedPoint) {
                        insidePinned = isPointInPolygon(pinnedPoint, inside);
                        outsidePinned = isPointInPolygon(pinnedPoint, outside);
                    }
                    let insidePinEdge, insidePinT, outsidePinEdge, outsidePinT;
                    if (insidePinned) {
                        const e = findClosestEdge(inside, pinnedPoint);
                        insidePinEdge = e.index;
                        insidePinT = e.t;
                    }
                    if (outsidePinned) {
                        const e2 = findClosestEdge(outside, pinnedPoint);
                        outsidePinEdge = e2.index;
                        outsidePinT = e2.t;
                    }

                    const pieceA = {
                        points: inside,
                        vx: body.vx - 40,
                        vy: body.vy + 20,
                        angularVelocity: body.angularVelocity + 0.4,
                        color: body.color,
                        rotation: body.rotation,
                        pinned: !!insidePinned,
                        pinEdge: insidePinEdge,
                        pinT: insidePinT,
                        isGrabbed: false,
                    };
                    const pieceB = {
                        points: outside,
                        vx: body.vx + 40,
                        vy: body.vy + 20,
                        angularVelocity: body.angularVelocity - 0.4,
                        color: body.color,
                        rotation: body.rotation,
                        pinned: !!outsidePinned,
                        pinEdge: outsidePinEdge,
                        pinT: outsidePinT,
                        isGrabbed: false,
                    };

                    bodies.splice(i, 1, pieceA, pieceB);
                    break;
                }
                tearPath = null;
                return;
            }
        }

        // fallback: perform sequential segment cuts
        performTear(tearPath);
        tearPath = null;
    }
});

canvas.addEventListener("mouseleave", () => {
    if (interactionMode === "grab") {
        if (selectedBody) selectedBody.isGrabbed = false;
        selectedBody = null;
        isDragging = false;
        return;
    }
    if (interactionMode === "cut" && isDragging) {
        isDragging = false;
        handleCut();
    }
});

cutButton.addEventListener("click", () => {
    setInteractionMode("cut");
});

grabButton.addEventListener("click", () => {
    setInteractionMode("grab");
});

pinButton.addEventListener("click", () => {
    setInteractionMode("pin");
});

if (tearButton) {
    tearButton.addEventListener("click", () => {
        setInteractionMode("tear");
    });
}

toggleMenuButton.addEventListener("click", () => {
    setToolbarCollapsed(!toolbar.classList.contains("collapsed"));
});

resetButton.addEventListener("click", () => {
    resetScene();
});

window.addEventListener("resize", resizeCanvas);

resizeCanvas();
resetScene();
requestAnimationFrame((time) => {
    lastTime = time;
    animate(time);
});
