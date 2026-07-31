document.getElementById('addDrugBtn').addEventListener('click', async (e) => {
  e.preventDefault(); // Prevents full page reload
  
  const drugData = {
    name: document.getElementById('drugName').value,
    sku: document.getElementById('sku').value,
    unit_price: parseFloat(document.getElementById('price').value) || 0,
    quantity: parseInt(document.getElementById('quantity').value, 10) || 0
  };

  try {
    const response = await fetch('/api/inventory', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('token')}`
      },
      body: JSON.stringify(drugData)
    });

    const data = await response.json();

    if (response.ok) {
      alert('Drug added successfully!');
      // Code to close modal or refresh list
    } else {
      console.error('Server error:', data);
      alert(data.message || 'Failed to add drug.');
    }
  } catch (err) {
    console.error('Network/Client Error:', err);
  }
});
