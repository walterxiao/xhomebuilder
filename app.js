const floorplan = document.getElementById('floorplan');
const paletteButtons = document.querySelectorAll('.palette-item');

let activeDrag = null;
let dragOffset = { x: 0, y: 0 };

const furnitureLabels = {
  sofa: 'Sofa',
  table: 'Table',
  chair: 'Chair',
  bed: 'Bed',
  shelf: 'Shelf',
};

paletteButtons.forEach((button) => {
  button.addEventListener('pointerdown', onPalettePointerDown);
});

function onPalettePointerDown(event) {
  event.preventDefault();
  const type = event.currentTarget.dataset.type;
  const preview = createFurnitureElement(type, 0, 0, true);
  preview.classList.add('drag-preview');
  document.body.appendChild(preview);

  activeDrag = {
    kind: 'new',
    type,
    preview,
  };

  updatePreviewPosition(event.clientX, event.clientY);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp, { once: true });
}

function onPointerMove(event) {
  if (!activeDrag) return;

  if (activeDrag.kind === 'new') {
    updatePreviewPosition(event.clientX, event.clientY);
  } else if (activeDrag.kind === 'move') {
    moveFurniture(activeDrag.item, event.clientX, event.clientY);
  }
}

function onPointerUp(event) {
  if (!activeDrag) return;

  if (activeDrag.kind === 'new') {
    const dropRect = floorplan.getBoundingClientRect();
    if (isInsideFloorplan(event.clientX, event.clientY, dropRect)) {
      const x = event.clientX - dropRect.left - activeDrag.preview.offsetWidth / 2;
      const y = event.clientY - dropRect.top - activeDrag.preview.offsetHeight / 2;
      const furniture = createFurnitureElement(activeDrag.type, x, y);
      floorplan.appendChild(furniture);
    }
    activeDrag.preview.remove();
  } else if (activeDrag.kind === 'move') {
    activeDrag.item.classList.remove('dragging');
  }

  activeDrag = null;
  window.removeEventListener('pointermove', onPointerMove);
}

function createFurnitureElement(type, x, y, isPreview = false) {
  const furniture = document.createElement('div');
  furniture.className = `furniture furniture-${type}`;
  furniture.dataset.type = type;
  furniture.style.left = `${x}px`;
  furniture.style.top = `${y}px`;
  furniture.textContent = furnitureLabels[type] || 'Item';

  if (!isPreview) {
    furniture.addEventListener('pointerdown', onFurniturePointerDown);
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'remove-button';
    removeButton.textContent = '×';
    removeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      furniture.remove();
    });
    furniture.appendChild(removeButton);
  }

  return furniture;
}

function onFurniturePointerDown(event) {
  if (event.target.classList.contains('remove-button')) return;
  event.preventDefault();

  const furniture = event.currentTarget;
  const rect = furniture.getBoundingClientRect();
  dragOffset.x = event.clientX - rect.left;
  dragOffset.y = event.clientY - rect.top;

  activeDrag = {
    kind: 'move',
    item: furniture,
  };

  furniture.classList.add('dragging');
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp, { once: true });
}

function updatePreviewPosition(clientX, clientY) {
  if (!activeDrag || !activeDrag.preview) return;
  activeDrag.preview.style.left = `${clientX}px`;
  activeDrag.preview.style.top = `${clientY}px`;
}

function moveFurniture(item, clientX, clientY) {
  const floorRect = floorplan.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();

  let x = clientX - floorRect.left - dragOffset.x;
  let y = clientY - floorRect.top - dragOffset.y;

  x = Math.max(0, Math.min(x, floorplan.clientWidth - itemRect.width));
  y = Math.max(0, Math.min(y, floorplan.clientHeight - itemRect.height));

  item.style.left = `${x}px`;
  item.style.top = `${y}px`;
}

function isInsideFloorplan(clientX, clientY, floorRect) {
  return (
    clientX >= floorRect.left &&
    clientX <= floorRect.right &&
    clientY >= floorRect.top &&
    clientY <= floorRect.bottom
  );
}
