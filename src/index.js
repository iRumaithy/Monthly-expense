// Main Application Logic
document.addEventListener('DOMContentLoaded', () => {
  const uploadArea = document.getElementById('uploadArea');
  const fileInput = document.getElementById('fileInput');
  const expenseList = document.getElementById('expenseList');
  const totalAmountEl = document.getElementById('totalAmount');

  let expenses = JSON.parse(localStorage.getItem('expenses') || '[]');

  function renderExpenses() {
    if (expenses.length === 0) {
      expenseList.innerHTML = '<li class="empty-state">لا توجد مصاريف مسجلة حتى الآن</li>';
      totalAmountEl.textContent = '0.00 د.إ';
      return;
    }

    expenseList.innerHTML = '';
    let total = 0;

    expenses.forEach((exp, index) => {
      total += exp.amount;
      const li = document.createElement('li');
      li.className = 'expense-item';
      li.innerHTML = `
        <div class="expense-info">
          <div class="title">${exp.title}</div>
          <div class="date">${exp.date}</div>
        </div>
        <div class="expense-amount">-${exp.amount.toFixed(2)} د.إ</div>
      `;
      expenseList.appendChild(li);
    });

    totalAmountEl.textContent = `${total.toFixed(2)} د.إ`;
  }

  uploadArea.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      // Simulate AI Scanning process
      uploadArea.querySelector('h3').textContent = 'جاري تحليل الفاتورة بواسطة الذكاء الاصطناعي...';
      
      setTimeout(() => {
        const mockExpense = {
          title: 'فاتورة مشتريات (تحليل تلقائي)',
          amount: Math.floor(Math.random() * 150) + 20,
          date: new Date().toLocaleDateString('ar-AE')
        };
        
        expenses.unshift(mockExpense);
        localStorage.setItem('expenses', JSON.stringify(expenses));
        renderExpenses();
        
        uploadArea.querySelector('h3').textContent = 'مسح الفاتورة أو الإيصال';
        alert('تمت إضافة المصروف بنجاح!');
      }, 1500);
    }
  });

  renderExpenses();
});
