import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.154/build/three.module.js';
import { PointerLockControls } from 'https://cdn.jsdelivr.net/npm/three@0.154/examples/jsm/controls/PointerLockControls.js';
import { CapsuleGeometry } from 'https://cdn.jsdelivr.net/npm/three@0.154/examples/jsm/geometries/CapsuleGeometry.js';

// DOM elements
const menu = document.getElementById('menu');
const startBtn = document.getElementById('startBtn');
const nameInput = document.getElementById('nameInput');
const crosshair = document.getElementById('crosshair');
const scoreboardDiv = document.getElementById('scoreboard');
const endScreen = document.getElementById('endScreen');
const resultsDiv = document.getElementById('results');
const restartBtn = document.getElementById('restartBtn');

// Game state
let socket;
let playerId = null;
let playerName = '';
const players = new Map(); // id -> { mesh, name, kills, deaths, state }
let localState = null;
let localKills = 0;
let localDeaths = 0;

// Movement state
const keys = {};
let lastShotTime = 0;
const reloadTime = 1.5; // seconds
let ammo = 30;
const maxAmmo = 30;
let reloading = false;
let slideTimer = 0;
const slideDuration = 0.4;

// Match timer
const matchDuration = 300; // seconds
let matchStartTime = null;
let matchEnded = false;

startBtn.addEventListener('click', () => {
  playerName = nameInput.value.trim() || `Speler${Math.floor(Math.random() * 1000)}`;
  menu.style.display = 'none';
  initGame();
});

restartBtn.addEventListener('click', () => {
  location.reload();
});

function initGame() {
  // Create scene, camera, renderer
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x202020);
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(0, 1.6, 0);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  // Lighting
  const ambient = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambient);
  const directional = new THREE.DirectionalLight(0xffffff, 0.6);
  directional.position.set(5, 10, 7);
  scene.add(directional);

  // Controls
  const controls = new PointerLockControls(camera, renderer.domElement);
  document.addEventListener('click', () => {
    if (!controls.isLocked && !matchEnded) controls.lock();
  });

  // Map: floor
  const floorGeo = new THREE.PlaneGeometry(50, 50);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x444444 });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // Walls / obstacles
  const wallGeo = new THREE.BoxGeometry(3, 2, 1);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x556b2f });
  // Place a few random obstacles
  const obstaclePositions = [
    { x: -5, z: -5 },
    { x: 8, z: 3 },
    { x: -10, z: 10 },
    { x: 5, z: -10 },
  ];
  obstaclePositions.forEach((pos) => {
    const wall = new THREE.Mesh(wallGeo, wallMat);
    wall.position.set(pos.x, 1, pos.z);
    scene.add(wall);
  });

  // Data structure for obstacles for collision detection
  const obstacleBoxes = [];
  obstaclePositions.forEach((pos) => {
    obstacleBoxes.push({ min: { x: pos.x - 1.5, y: 0, z: pos.z - 0.5 }, max: { x: pos.x + 1.5, y: 2, z: pos.z + 0.5 } });
  });

  // Scoreboard UI
  function updateScoreboard() {
    let html = '<h3>Scorebord</h3>';
    // Build an array of all players including local player
    const list = [];
    for (const [id, p] of players.entries()) {
      list.push({ id, name: p.name, kills: p.kills || 0, deaths: p.deaths || 0 });
    }
    list.push({ id: playerId, name: playerName, kills: localKills, deaths: localDeaths });
    list.sort((a, b) => b.kills - a.kills);
    list.forEach((p) => {
      const you = p.id === playerId ? ' (jij)' : '';
      html += `<div>${p.name}${you}: ${p.kills} / ${p.deaths}</div>`;
    });
    html += `<div>Ammo: ${ammo}${reloading ? ' (herladen...)' : ''}</div>`;
    scoreboardDiv.innerHTML = html;
  }

  // Networking
  socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  socket.onopen = () => {
    // Initialize player state
    localState = {
      x: camera.position.x,
      y: camera.position.y,
      z: camera.position.z,
      yaw: 0,
      pitch: 0,
      health: 100,
    };
  };
  socket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    switch (data.type) {
      case 'welcome':
        playerId = data.id;
        // send init with name and initial state
        send({ type: 'init', name: playerName, state: localState });
        matchStartTime = performance.now() / 1000;
        break;
      case 'playerJoined': {
        const { id, name, state, kills, deaths } = data;
        if (id === playerId) break;
        // Create a remote player mesh
        const geom = new CapsuleGeometry(0.3, 1.2, 4, 8);
        const mat = new THREE.MeshStandardMaterial({ color: 0x0077cc });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.position.set(state.x, state.y - 0.8, state.z);
        scene.add(mesh);
        players.set(id, { mesh, name, kills: kills || 0, deaths: deaths || 0, state });
        updateScoreboard();
        break;
      }
      case 'playerLeft': {
        const { id } = data;
        const p = players.get(id);
        if (p) {
          scene.remove(p.mesh);
          players.delete(id);
          updateScoreboard();
        }
        break;
      }
      case 'update': {
        const { id, state } = data;
        if (id === playerId) {
          // Update our own state from server (e.g., respawn)
          localState.x = state.x;
          localState.y = state.y;
          localState.z = state.z;
          localState.health = state.health;
          camera.position.set(state.x, state.y, state.z);
          break;
        }
        const p = players.get(id);
        if (p) {
          p.state = state;
          p.mesh.position.set(state.x, state.y - 0.8, state.z);
          p.mesh.rotation.y = state.yaw;
        }
        break;
      }
      case 'playerKilled': {
        const { killer, victim } = data;
        const killerP = players.get(killer) || (playerId === killer ? { kills: 0 } : null);
        const victimP = players.get(victim) || (playerId === victim ? { deaths: 0 } : null);
        if (killerP) killerP.kills = (killerP.kills || 0) + 1;
        if (victimP) victimP.deaths = (victimP.deaths || 0) + 1;
        if (killer === playerId) localKills++;
        if (victim === playerId) localDeaths++;
        updateScoreboard();
        break;
      }
      default:
        break;
    }
  };
  socket.onclose = () => {
    alert('Verbinding met server verbroken.');
  };

  function send(obj) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(obj));
    }
  }

  // Keyboard input
  document.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    // Prevent default scroll with space, arrow keys
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  });
  document.addEventListener('keyup', (e) => {
    keys[e.code] = false;
  });
  document.addEventListener('mousedown', (e) => {
    if (e.button === 0 && controls.isLocked && !reloading && ammo > 0) {
      shoot();
    }
  });

  function shoot() {
    const now = performance.now() / 1000;
    // Fire rate limitation: 0.15s
    if (now - lastShotTime < 0.15) return;
    lastShotTime = now;
    ammo--;
    if (ammo <= 0) {
      startReload();
    }
    // Compute origin and direction for bullet
    const origin = new THREE.Vector3(localState.x, localState.y, localState.z);
    const direction = new THREE.Vector3();
    camera.getWorldDirection(direction);
    direction.normalize();
    send({ type: 'shoot', origin: { x: origin.x, y: origin.y, z: origin.z }, direction: { x: direction.x, y: direction.y, z: direction.z } });
    // Visual muzzle flash: small sphere quickly fading
    const flashGeo = new THREE.SphereGeometry(0.05, 8, 8);
    const flashMat = new THREE.MeshBasicMaterial({ color: 0xffa500 });
    const flash = new THREE.Mesh(flashGeo, flashMat);
    flash.position.copy(camera.position).add(direction.clone().multiplyScalar(0.5));
    scene.add(flash);
    setTimeout(() => {
      scene.remove(flash);
    }, 100);
    updateScoreboard();
  }

  function startReload() {
    if (reloading) return;
    reloading = true;
    setTimeout(() => {
      ammo = maxAmmo;
      reloading = false;
      updateScoreboard();
    }, reloadTime * 1000);
  }

  // Movement physics
  const gravity = 25;
  let velocityY = 0;
  function handleMovement(delta) {
    // Determine direction vectors
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3();
    right.crossVectors(forward, camera.up).normalize();

    let moveDir = new THREE.Vector3();
    if (keys['KeyW']) moveDir.add(forward);
    if (keys['KeyS']) moveDir.sub(forward);
    if (keys['KeyA']) moveDir.sub(right);
    if (keys['KeyD']) moveDir.add(right);
    if (moveDir.lengthSq() > 0) moveDir.normalize();
    let speed = 6; // default run speed m/s
    const isCrouching = keys['ShiftLeft'] || keys['ShiftRight'];
    if (isCrouching) speed = 3;
    if (keys['ControlLeft'] || keys['ControlRight']) {
      // slide: boost speed for a short duration
      if (slideTimer <= 0) {
        slideTimer = slideDuration;
      }
    }
    if (slideTimer > 0) {
      speed = 9;
      slideTimer -= delta;
      if (slideTimer < 0) slideTimer = 0;
    }
    // Update horizontal position
    localState.x += moveDir.x * speed * delta;
    localState.z += moveDir.z * speed * delta;

    // Jumping
    if (keys['Space'] && localState.y <= 1.6 + 0.01) {
      velocityY = 8;
    }
    // Apply gravity
    velocityY -= gravity * delta;
    localState.y += velocityY * delta;
    // Prevent falling below ground
    const standHeight = isCrouching ? 1.0 : 1.6;
    if (localState.y < standHeight) {
      localState.y = standHeight;
      velocityY = 0;
    }
    // Collision with obstacles (very simple AABB check)
    obstacleBoxes.forEach((box) => {
      // Check horizontal collision only
      const radius = 0.3;
      if (
        localState.x + radius > box.min.x &&
        localState.x - radius < box.max.x &&
        localState.z + radius > box.min.z &&
        localState.z - radius < box.max.z &&
        localState.y < box.max.y
      ) {
        // Undo movement along X and Z
        // Determine minimal translation vector
        const dx1 = box.max.x - (localState.x - radius);
        const dx2 = (localState.x + radius) - box.min.x;
        const dz1 = box.max.z - (localState.z - radius);
        const dz2 = (localState.z + radius) - box.min.z;
        const minX = dx1 < dx2 ? -dx1 : dx2;
        const minZ = dz1 < dz2 ? -dz1 : dz2;
        if (Math.abs(minX) < Math.abs(minZ)) {
          localState.x += minX;
        } else {
          localState.z += minZ;
        }
      }
    });
    // Update camera position
    camera.position.set(localState.x, localState.y, localState.z);
    // Update yaw/pitch
    localState.yaw = controls.getObject().rotation.y;
    localState.pitch = controls.getObject().rotation.x;
    // Send update to server
    send({ type: 'update', state: localState });
  }

  // Handle window resize
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Main loop
  let prevTime = performance.now() / 1000;
  function animate() {
    if (matchEnded) return;
    const currentTime = performance.now() / 1000;
    const delta = currentTime - prevTime;
    prevTime = currentTime;

    // Update movement
    if (controls.isLocked) {
      handleMovement(delta);
    }
    renderer.render(scene, camera);

    // Update scoreboard periodically
    updateScoreboard();

    // End match if time expired
    if (matchStartTime && currentTime - matchStartTime >= matchDuration) {
      endMatch();
    }
    requestAnimationFrame(animate);
  }
  animate();

  function endMatch() {
    matchEnded = true;
    // Display results
    let html = '<h3>Resultaten</h3>';
    const arr = Array.from(players.entries());
    arr.push([playerId, { name: playerName, kills: localState.kills || 0, deaths: localState.deaths || 0 }]);
    arr.forEach(([id, p]) => {
      const name = id === playerId ? playerName + ' (jij)' : p.name;
      html += `<div>${name}: ${p.kills || 0} / ${p.deaths || 0}</div>`;
    });
    resultsDiv.innerHTML = html;
    endScreen.classList.remove('hidden');
    // Unlock pointer and show cursor
    controls.unlock();
    crosshair.style.display = 'none';
  }
}