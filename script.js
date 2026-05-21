const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const resetButton = document.getElementById("resetButton");
const cutButton = document.getElementById("cutButton");
const tearButton = document.getElementById("tearButton");
const grabButton = document.getElementById("grabButton");
const pinButton = document.getElementById("pinButton");
const toggleMenuButton = document.getElementById("toggleMenuButton");
const toolbar = document.querySelector(".toolbar");
const createMenuButton = document.getElementById("createMenuButton");
const createMenu = document.getElementById("createMenu");
const createRectButton = document.getElementById("createRectButton");
const createCircleButton = document.getElementById("createCircleButton");
const createTriangleButton = document.getElementById("createTriangleButton");
const createFreeButton = document.getElementById("createFreeButton");
const deleteButton = document.getElementById("deleteButton");

let bodies = [];
let interactionMode = "cut";
let selectedBody = null;
let isDragging = false;
let dragStart = null;
let dragStartPoints = null;
let cutLine = null;
let tearPath = null;
let lastDrag = {x: 0, y: 0, time: 0};
let menuCollapsed = false;
let lastTime = 0;

// creation UI state
let creationMode = null; // 'rect'|'circle'|'triangle'|'free'
let createPreviewStart = null;
let createPreviewCurrent = null;
let createPreviewFree = null;
const gravity = 1800; // px/s^2
const groundY = 0;
const floorHeight = 28;
const globalDamping = 0.99;

console.log("script.js loaded");

function setInteractionMode(mode) {
    interactionMode = mode;
    selectedBody = null;
    isDragging = false;

    const buttons = {
        cut: cutButton,
        grab: grabButton,
        pin: pinButton,
        tear: tearButton,
        create: createMenuButton,
        delete: deleteButton,
    };

    // 모든 버튼의 active 클래스를 모드에 따라 일괄 업데이트
    Object.entries(buttons).forEach(([key, btn]) => {
        if (btn) btn.classList.toggle("active", mode === key);
    });

    // 모드에 따른 마우스 커서 변경
    if (mode === "delete") {
        // 휴지통 모양 커서 (SVG 데이터 URL)
        canvas.style.cursor = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Ctext y='24' font-size='24'%3E%F0%9F%97%91%3C/text%3E%3C/svg%3E\"), auto";
    } else if (mode === "grab") {
        canvas.style.cursor = "grab";
    } else if (mode === "cut" || mode === "tear" || mode === "create") {
        canvas.style.cursor = "crosshair";
    } else {
        canvas.style.cursor = "default";
    }
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

function smoothPath(path, iterations = 2) {
    if (path.length < 3) return path;
    let result = path;
    for (let i = 0; i < iterations; i++) {
        let next = [result[0]];
        for (let j = 0; j < result.length - 1; j++) {
            const p0 = result[j];
            const p1 = result[j + 1];
            // Chaikin's corner cutting: 점 사이의 1/4, 3/4 지점에 새로운 점 생성
            next.push({x: 0.75 * p0.x + 0.25 * p1.x, y: 0.75 * p0.y + 0.25 * p1.y});
            next.push({x: 0.25 * p0.x + 0.75 * p1.x, y: 0.25 * p0.y + 0.75 * p1.y});
        }
        next.push(result[result.length - 1]);
        result = next;
    }
    return result;
}

function performTear(path) {
    if (!path || path.length < 2) return;
    for (let i = bodies.length - 1; i >= 0; i--) {
        const body = bodies[i];
        const intersections = [];
        for (let s = 0; s < path.length - 1; s++) {
            const line = {x1: path[s].x, y1: path[s].y, x2: path[s + 1].x, y2: path[s + 1].y};
            for (let j = 0; j < body.points.length; j++) {
                const p1 = body.points[j];
                const p2 = body.points[(j + 1) % body.points.length];
                const inter = segmentIntersection(p1, p2, line);
                if (inter) {
                    intersections.push({
                        point: inter,
                        edgeIdx: j,
                        pathIdx: s,
                    });
                }
            }
        }

        // 2. 정확히 두 번 가로지르는 경우에만 분할 수행 (가장 흔하고 안정적인 케이스)
        if (intersections.length >= 2) {
            // 입구와 출구 지점 선정 (가장 처음과 마지막 교차점)
            const entry = intersections[0];
            const exit = intersections[intersections.length - 1];

            if (entry.edgeIdx === exit.edgeIdx && intersections.length === 2) continue; // 같은 변에서 나가는 경우 제외

            // 경로 추출 (entry에서 exit까지의 마우스 궤적)
            const pathMid = path.slice(entry.pathIdx + 1, exit.pathIdx + 1);
            const reversePathMid = [...pathMid].reverse();

            // 첫 번째 조각 구성
            let points1 = [entry.point, ...pathMid, exit.point];
            let curr = (exit.edgeIdx + 1) % body.points.length;
            while (curr !== (entry.edgeIdx + 1) % body.points.length) {
                points1.push(body.points[curr]);
                curr = (curr + 1) % body.points.length;
            }

            // 두 번째 조각 구성
            let points2 = [exit.point, ...reversePathMid, entry.point];
            curr = (entry.edgeIdx + 1) % body.points.length;
            while (curr !== (exit.edgeIdx + 1) % body.points.length) {
                points2.push(body.points[curr]);
                curr = (curr + 1) % body.points.length;
            }

            if (polygonArea(points1) > 100 && polygonArea(points2) > 100) {
                const b1 = spawnNewBody(points1, body.color);
                const b2 = spawnNewBody(points2, body.color);

                // 물리 전이 (폭발 효과)
                if (b1) {
                    b1.vx = body.vx - 20;
                    b1.vy = body.vy;
                    b1.angularVelocity = -0.5;
                }
                if (b2) {
                    b2.vx = body.vx + 20;
                    b2.vy = body.vy;
                    b2.angularVelocity = 0.5;
                }

                bodies.splice(i, 1);
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

function spawnNewBody(points, color) {
    if (!points || points.length < 3) return null;
    const pts = points.map((p) => ({x: p.x, y: p.y}));
    const body = {points: pts, vx: 0, vy: 0, angularVelocity: 0, color: color || randomPaperColor(), rotation: 0, pinned: false, isGrabbed: false};
    bodies.push(body);
    return body;
}

function randomPaperColor() {
    const choices = ["#f9f2d6", "#fff4f0", "#f0fff4", "#f7f3ff", "#fff9e6"];
    return choices[Math.floor(Math.random() * choices.length)];
}

function clipPolygonByPolygon(subject, clip, keepInside = true) {
    if (!subject || subject.length === 0 || !clip || clip.length === 0) return [];
    let output = subject.slice();
    const clipArea = polygonSignedArea(clip);
    const clipSign = clipArea >= 0 ? 1 : -1;

    for (let i = 0; i < clip.length; i++) {
        const a = clip[i];
        const b = clip[(i + 1) % clip.length];
        const input = output.slice();
        output = [];
        for (let j = 0; j < input.length; j++) {
            const cur = input[j];
            const prev = input[(j - 1 + input.length) % input.length];
            const side = clipSign * lineSide(cur, {x1: a.x, y1: a.y, x2: b.x, y2: b.y});
            const prevSide = clipSign * lineSide(prev, {x1: a.x, y1: a.y, x2: b.x, y2: b.y});
            const curInside = keepInside ? side >= 0 : side <= 0;
            const prevInside = keepInside ? prevSide >= 0 : prevSide <= 0;

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

function getMomentOfInertia(body) {
    const points = body.points;
    const mass = polygonArea(points);
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < points.length; i++) {
        const j = (i + 1) % points.length;
        const cross = Math.abs(points[i].x * points[j].y - points[j].x * points[i].y);
        const p1_sq = points[i].x ** 2 + points[i].y ** 2;
        const p2_sq = points[j].x ** 2 + points[j].y ** 2;
        const p1_p2 = points[i].x * points[j].x + points[i].y * points[j].y;
        numerator += cross * (p1_sq + p1_p2 + p2_sq);
        denominator += cross;
    }
    return (mass / 6) * (numerator / (denominator || 1));
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
    applyCut({x1: cutLine.x1, y1: cutLine.y1, x2: cutLine.x2, y2: cutLine.y2});
    cutLine = null;
}

function applyCut(line) {
    const lineLength = Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
    if (lineLength < 10) return;

    // 역순 순회를 통해 요소를 삭제해도 인덱스 문제가 발생하지 않도록 함
    for (let i = bodies.length - 1; i >= 0; i--) {
        const body = bodies[i];
        if (lineIntersectionCount(body.points, line) < 2) continue;
        if (!intersectsPolygon(body.points, line)) continue;
        const pieces = cutBody(body, line);
        if (pieces) {
            bodies.splice(i, 1, pieces[0], pieces[1]);
        }
    }
}

function getSATCollision(bodyA, bodyB) {
    let minOverlap = Infinity;
    let collisionNormal = null;

    const polys = [bodyA.points, bodyB.points];
    for (let p = 0; p < 2; p++) {
        const points = polys[p];
        for (let i = 0; i < points.length; i++) {
            const next = points[(i + 1) % points.length];
            const edge = {x: next.x - points[i].x, y: next.y - points[i].y};
            // Normal to the edge
            const normal = {x: -edge.y, y: edge.x};
            const len = Math.hypot(normal.x, normal.y);
            if (len < 1e-6) continue;
            normal.x /= len;
            normal.y /= len;

            let minA = Infinity,
                maxA = -Infinity;
            for (const pt of bodyA.points) {
                const proj = pt.x * normal.x + pt.y * normal.y;
                minA = Math.min(minA, proj);
                maxA = Math.max(maxA, proj);
            }
            let minB = Infinity,
                maxB = -Infinity;
            for (const pt of bodyB.points) {
                const proj = pt.x * normal.x + pt.y * normal.y;
                minB = Math.min(minB, proj);
                maxB = Math.max(maxB, proj);
            }

            const overlap = Math.min(maxA, maxB) - Math.max(minA, minB);
            if (overlap <= 0) return null;

            if (overlap < minOverlap) {
                minOverlap = overlap;
                collisionNormal = {...normal};
            }
        }
    }

    const centerA = polygonCentroid(bodyA.points);
    const centerB = polygonCentroid(bodyB.points);
    if ((centerB.x - centerA.x) * collisionNormal.x + (centerB.y - centerA.y) * collisionNormal.y < 0) {
        collisionNormal.x *= -1;
        collisionNormal.y *= -1;
    }

    return {normal: collisionNormal, depth: minOverlap};
}

function resolveBodyCollision(bodyA, bodyB, info) {
    const restitution = 0.4; // 반발 계수
    const centerA = polygonCentroid(bodyA.points);
    const centerB = polygonCentroid(bodyB.points);

    // 충돌 지점 근사 (단순화를 위해 충돌 깊이의 중간 지점 사용)
    const contactPoint = {
        x: centerA.x + (centerB.x - centerA.x) * 0.5,
        y: centerA.y + (centerB.y - centerA.y) * 0.5,
    };

    const ra = {x: contactPoint.x - centerA.x, y: contactPoint.y - centerA.y};
    const rb = {x: contactPoint.x - centerB.x, y: contactPoint.y - centerB.y};

    // 충돌 지점에서의 상대 속도 (선속도 + 각속도에 의한 속도)
    const va = {x: bodyA.vx - bodyA.angularVelocity * ra.y, y: bodyA.vy + bodyA.angularVelocity * ra.x};
    const vb = {x: bodyB.vx - bodyB.angularVelocity * rb.y, y: bodyB.vy + bodyB.angularVelocity * rb.x};

    const relVx = vb.x - va.x;
    const relVy = vb.y - va.y;
    const velAlongNormal = relVx * info.normal.x + relVy * info.normal.y;

    if (velAlongNormal > 0) return;

    const massA = polygonArea(bodyA.points);
    const massB = polygonArea(bodyB.points);
    const inertiaA = getMomentOfInertia(bodyA);
    const inertiaB = getMomentOfInertia(bodyB);

    const invMassA = bodyA.pinned ? 0 : 1 / massA;
    const invMassB = bodyB.pinned ? 0 : 1 / massB;
    const invInertiaA = bodyA.pinned ? 0 : 1 / inertiaA;
    const invInertiaB = bodyB.pinned ? 0 : 1 / inertiaB;

    // 회전 성분을 포함한 충격량 공식
    const raCrossN = ra.x * info.normal.y - ra.y * info.normal.x;
    const rbCrossN = rb.x * info.normal.y - rb.y * info.normal.x;

    const invMassSum = invMassA + invMassB + raCrossN ** 2 * invInertiaA + rbCrossN ** 2 * invInertiaB;

    if (invMassSum === 0) return;

    const j = (-(1 + restitution) * velAlongNormal) / invMassSum;
    const impulse = {x: j * info.normal.x, y: j * info.normal.y};

    if (!bodyA.pinned) {
        bodyA.vx -= impulse.x * invMassA;
        bodyA.vy -= impulse.y * invMassA;
        bodyA.angularVelocity -= raCrossN * j * invInertiaA;
    }
    if (!bodyB.pinned) {
        bodyB.vx += impulse.x * invMassB;
        bodyB.vy += impulse.y * invMassB;
        bodyB.angularVelocity += rbCrossN * j * invInertiaB;
    }

    // [개선] 다른 도형 위에 안착할 때의 마찰력 강화
    const frictionCoeff = Math.abs(info.normal.y) > 0.7 ? 0.8 : 0.4;
    const tangent = {x: -info.normal.y, y: info.normal.x};
    const relVelT = (vb.x - va.x) * tangent.x + (vb.y - va.y) * tangent.y;

    const raCrossT = ra.x * tangent.y - ra.y * tangent.x;
    const rbCrossT = rb.x * tangent.y - rb.y * tangent.x;
    const invMassSumT = invMassA + invMassB + raCrossT ** 2 * invInertiaA + rbCrossT ** 2 * invInertiaB;

    if (invMassSumT > 0) {
        let jt = -relVelT / invMassSumT;
        const maxFriction = Math.abs(j * frictionCoeff);
        jt = Math.max(-maxFriction, Math.min(maxFriction, jt));

        const fImpulse = {x: jt * tangent.x, y: jt * tangent.y};
        if (!bodyA.pinned) {
            bodyA.vx -= fImpulse.x * invMassA;
            bodyA.vy -= fImpulse.y * invMassA;
            bodyA.angularVelocity -= raCrossT * jt * invInertiaA;
        }
        if (!bodyB.pinned) {
            bodyB.vx += fImpulse.x * invMassB;
            bodyB.vy += fImpulse.y * invMassB;
            bodyB.angularVelocity += rbCrossT * jt * invInertiaB;
        }
    }

    // [개선] 상대 속도가 매우 낮고 법선이 수직인 경우 (도형 위에 안정적으로 놓임)
    if (Math.abs(velAlongNormal) < 5 && Math.abs(info.normal.y) > 0.8) {
        if (!bodyA.pinned && !bodyA.isGrabbed) bodyA.vx *= 0.8;
        if (!bodyB.pinned && !bodyB.isGrabbed) bodyB.vx *= 0.8;
    }

    const percent = 0.5; // 침투 보정 강도
    const slop = 0.01;
    const correction = (Math.max(info.depth - slop, 0) / invMassSum) * percent;
    const move = {x: info.normal.x * correction, y: info.normal.y * correction};
    if (!bodyA.pinned) translateBody(bodyA, -move.x * invMassA, -move.y * invMassA);
    if (!bodyB.pinned) translateBody(bodyB, move.x * invMassB, move.y * invMassB);
}

function resolveFloorCollision(body, floorY, deltaTime) {
    const restitution = 0.15; // 바닥 안착을 위해 반발력 약간 하향
    const friction = 0.7; // 미끄러짐 방지를 위해 마찰력 상향
    const centroid = polygonCentroid(body.points);
    const invMass = 1 / polygonArea(body.points);
    const invInertia = 1 / getMomentOfInertia(body);

    let collisionOccurred = false;
    let contacts = [];

    body.points.forEach((p) => {
        if (p.y >= floorY - 1.5) {
            // 접점 감지 범위를 살짝 넓혀 선분 접촉 유도
            collisionOccurred = true;
            const r = {x: p.x - centroid.x, y: p.y - centroid.y};
            const vAtPoint = {
                x: body.vx - body.angularVelocity * r.y,
                y: body.vy + body.angularVelocity * r.x,
            };

            contacts.push({p, r});
            // 바닥은 위쪽 방향({0, -1})으로만 힘을 작용
            if (vAtPoint.y > 0) {
                const rCrossN = -r.x; // r x {0, -1}
                const invMassSum = invMass + rCrossN ** 2 * invInertia;

                // 수직 충격량
                const j = (-(1 + restitution) * vAtPoint.y) / invMassSum;
                body.vy += j * invMass;
                body.angularVelocity += rCrossN * j * invInertia;

                // 바닥 마찰력 (가로 방향 속도 감속)
                const vTangent = vAtPoint.x;
                const rCrossT = r.y;
                const invMassSumT = invMass + rCrossT ** 2 * invInertia;
                let jt = -vTangent / invMassSumT;
                const maxF = Math.abs(j * friction);
                jt = Math.max(-maxF, Math.min(maxF, jt));

                body.vx += jt * invMass;
                body.angularVelocity += rCrossT * jt * invInertia;
            }

            // 위치 보정 (바닥 뚫고 나가지 않게)
            if (p.y > floorY) translateBody(body, 0, floorY - p.y);
        }
    });

    if (collisionOccurred) {
        if (contacts.length >= 2) {
            // [개선] 두 개 이상의 꼭짓점이 닿으면(면 접촉), 에너지를 즉시 흡수하여 바닥에 안착시킵니다.
            body.vy = 0;
            body.angularVelocity = 0;
            body.vx *= 0.8; // 바닥 마찰로 인한 감속
        } else {
            // [개선] 꼭짓점이 하나만 닿았을 때는 각속도 감쇠를 강화하여(0.998 -> 0.96)
            // 버티지 못하고 빠르게 바닥으로 쓰러지도록 유도합니다.
            body.vx *= 0.99;
            body.angularVelocity *= 0.96;
        }
    }
}

function updateBodies(deltaTime) {
    bodies.forEach((body) => {
        if (body.pinned || body.isGrabbed) return;

        const area = polygonArea(body.points);
        const refArea = 114000; // 초기 종이 크기 (300x380)
        const massFactor = Math.sqrt(area / refArea); // 0.1 ~ 1.0 사이의 값

        // 질량에 따른 중력 가속도 조정 (무거운 조각이 공기 저항을 뚫고 더 빨리 떨어짐)
        const effectiveGravity = gravity * (0.85 + 0.15 * massFactor);
        body.vy += effectiveGravity * deltaTime;

        // 면적이 작을수록 공기 저항(Damping)을 더 많이 받음
        const effectiveDamping = globalDamping - 0.02 * (1 - massFactor);
        body.vx *= effectiveDamping;
        body.vy *= effectiveDamping;

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

        resolveFloorCollision(body, canvas.height - floorHeight, deltaTime);
    });

    for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
            const collision = getSATCollision(bodies[i], bodies[j]);
            if (collision) {
                resolveBodyCollision(bodies[i], bodies[j], collision);
            }
        }
    }
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

    // draw creation preview
    if (creationMode && createPreviewStart) {
        ctx.save();
        ctx.strokeStyle = "rgba(160,220,255,0.95)";
        ctx.fillStyle = "rgba(160,220,255,0.08)";
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 6]);
        if (creationMode === "rect") {
            const a = createPreviewStart;
            const b = createPreviewCurrent;
            ctx.beginPath();
            ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
            ctx.fill();
            ctx.stroke();
        } else if (creationMode === "circle") {
            const a = createPreviewStart;
            const b = createPreviewCurrent;
            const cx = a.x;
            const cy = a.y;
            const r = Math.hypot(b.x - a.x, b.y - a.y);
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        } else if (creationMode === "triangle") {
            const a = createPreviewStart;
            const b = createPreviewCurrent;
            const tri = makeTrianglePoints(a, b);
            ctx.beginPath();
            ctx.moveTo(tri[0].x, tri[0].y);
            ctx.lineTo(tri[1].x, tri[1].y);
            ctx.lineTo(tri[2].x, tri[2].y);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        } else if (creationMode === "free" && createPreviewFree && createPreviewFree.length) {
            ctx.beginPath();
            ctx.moveTo(createPreviewFree[0].x, createPreviewFree[0].y);
            for (let i = 1; i < createPreviewFree.length; i++) ctx.lineTo(createPreviewFree[i].x, createPreviewFree[i].y);
            ctx.stroke();
        }
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

    if (interactionMode === "create" && creationMode) {
        isDragging = true;
        createPreviewStart = pos;
        createPreviewCurrent = pos;
        if (creationMode === "free") createPreviewFree = [pos];
        return;
    }

    if (interactionMode === "delete") {
        const body = getBodyUnderPoint(pos);
        if (body) {
            const index = bodies.indexOf(body);
            if (index !== -1) {
                bodies.splice(index, 1);
                if (selectedBody === body) selectedBody = null;
            }
        }
        return;
    }

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
        selectedBody = body; // 클릭한 대상을 선택 (없으면 null로 선택 해제)
        if (body) {
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

    if (interactionMode === "create" && creationMode && isDragging) {
        createPreviewCurrent = pos;
        if (creationMode === "free" && createPreviewFree) {
            const last = createPreviewFree[createPreviewFree.length - 1];
            const dx = pos.x - last.x;
            const dy = pos.y - last.y;
            if (dx * dx + dy * dy > 9) createPreviewFree.push(pos);
        }
        return;
    }

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
    if (interactionMode === "create" && isDragging) {
        isDragging = false;
        let pts = null;
        if (creationMode === "rect") {
            pts = makeRectPoints(createPreviewStart, createPreviewCurrent);
        } else if (creationMode === "circle") {
            pts = makeCirclePoints(createPreviewStart, createPreviewCurrent);
        } else if (creationMode === "triangle") {
            pts = makeTrianglePoints(createPreviewStart, createPreviewCurrent);
        } else if (creationMode === "free") {
            pts = createPreviewFree;
        }

        if (pts && pts.length >= 3) {
            spawnNewBody(pts);
        }
        createPreviewStart = null;
        createPreviewCurrent = null;
        createPreviewFree = null;
        return;
    }

    if (interactionMode === "grab") {
        if (selectedBody) {
            selectedBody.vx = lastDrag.vx || 0;
            selectedBody.vy = lastDrag.vy || 0;
            selectedBody.isGrabbed = false;
        }
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
            const closeThreshold = 45 * 45; // 닫힘 감지 범위를 45px로 완화
            if (dist2 <= closeThreshold) {
                // closed polygon clip
                const clipPoly = tearPath.slice();
                // 모든 도형에 대해 검사
                for (let i = bodies.length - 1; i >= 0; i--) {
                    const body = bodies[i];
                    // compute intersection (inside area of clipPoly within the body)
                    const inside = clipPolygonByPolygon(clipPoly, body.points, true);
                    if (!inside || inside.length < 3) continue;
                    if (polygonArea(inside) < 40) continue;
                    const outside = clipPolygonByPolygon(body.points, clipPoly, false);
                    if (!outside || outside.length < 3 || polygonArea(outside) < 40) continue;

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

                    // create a new body for the cut-out area (inside) and keep outside as original with hole
                    const newBody = spawnNewBody(inside, body.color);
                    if (newBody) {
                        // transfer pin if it lies in the inside piece
                        if (insidePinned) {
                            newBody.pinned = true;
                            newBody.pinEdge = insidePinEdge;
                            newBody.pinT = insidePinT;
                            // remove pin from original
                            body.pinned = false;
                            delete body.pinEdge;
                            delete body.pinT;
                        }
                        // set original body to outside polygon
                        body.points = outside;
                        if (outsidePinned) {
                            body.pinned = true;
                            body.pinEdge = outsidePinEdge;
                            body.pinT = outsidePinT;
                        }
                    }
                }
            }
        }
        if (tearPath) performTear(smoothPath(tearPath));
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

// 도구 전환 버튼 이벤트 일괄 바인딩
[
    {el: cutButton, mode: "cut"},
    {el: grabButton, mode: "grab"},
    {el: pinButton, mode: "pin"},
    {el: tearButton, mode: "tear"},
    {el: deleteButton, mode: "delete"},
].forEach(({el, mode}) => {
    if (el) {
        el.addEventListener("click", () => {
            // 삭제 모드에서 다시 누르면 기본 모드(cut)로 토글
            if (mode === "delete" && interactionMode === "delete") {
                setInteractionMode("cut");
            } else {
                setInteractionMode(mode);
            }
        });
    }
});

// 생성 메뉴 토글
if (createMenuButton && createMenu) {
    createMenuButton.addEventListener("click", () => {
        createMenu.classList.toggle("hidden");
    });
}

// 도형 생성 옵션 버튼 이벤트 일괄 바인딩
[
    {el: createRectButton, type: "rect"},
    {el: createCircleButton, type: "circle"},
    {el: createTriangleButton, type: "triangle"},
    {el: createFreeButton, type: "free"},
].forEach(({el, type}) => {
    if (el) {
        el.addEventListener("click", () => {
            creationMode = type;
            setInteractionMode("create");
            if (createMenu) createMenu.classList.add("hidden");
        });
    }
});

// 삭제 기능 (Delete / Backspace 키)
window.addEventListener("keydown", (event) => {
    if ((event.key === "Delete" || event.key === "Backspace") && selectedBody) {
        const index = bodies.indexOf(selectedBody);
        if (index !== -1) {
            bodies.splice(index, 1);
            selectedBody = null;
        }
    }
});

toggleMenuButton.addEventListener("click", () => {
    setToolbarCollapsed(!toolbar.classList.contains("collapsed"));
});

function makeRectPoints(a, b) {
    const x1 = Math.min(a.x, b.x);
    const x2 = Math.max(a.x, b.x);
    const y1 = Math.min(a.y, b.y);
    const y2 = Math.max(a.y, b.y);
    return [
        {x: x1, y: y1},
        {x: x2, y: y1},
        {x: x2, y: y2},
        {x: x1, y: y2},
    ];
}

function makeCirclePoints(a, b) {
    const radius = Math.hypot(b.x - a.x, b.y - a.y);
    if (radius < 5) return null;
    const points = [];
    const segments = 24; // 원을 표현할 다각형의 변 개수
    for (let i = 0; i < segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        points.push({
            x: a.x + Math.cos(angle) * radius,
            y: a.y + Math.sin(angle) * radius,
        });
    }
    return points;
}

function makeTrianglePoints(a, b) {
    const left = {x: Math.min(a.x, b.x), y: Math.max(a.y, b.y)};
    const right = {x: Math.max(a.x, b.x), y: Math.max(a.y, b.y)};
    const top = {x: (a.x + b.x) / 2, y: Math.min(a.y, b.y)};
    return [top, right, left];
}

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
