(() => {
    'use strict';

    // Por enquanto, os comandos exibem alertas. A comunicação com a máquina ficará aqui.
    function startMachine() {
        alert('Comando: INICIAR');
    }

    function stopMachine() {
        alert('Comando: PARAR');
    }

    function resetMachine() {
        alert('Comando: RESET');
    }

    function emergencyStop() {
        alert('PARADA SOLICITADA!');
    }

    function navigateTo(page: string) {
        // Avisa qual tela foi escolhida no menu.
        // Quem escutar o evento home:navigate poderá carregar a tela indicada em detail.page.
        document.dispatchEvent(new CustomEvent('home:navigate', {
            detail: { page }
        }));
    }

    function initializeHome() {
        const commandHandlers: Record<string, (() => void) | undefined> = {
            start: startMachine,
            stop: stopMachine,
            reset: resetMachine,
            emergency: emergencyStop
        };

        document.querySelectorAll<HTMLButtonElement>('[data-command]').forEach((button) => {
            const command = button.dataset.command;
            const handler = command ? commandHandlers[command] : undefined;

            if (typeof handler === 'function') {
                button.addEventListener('click', handler);
            }
        });

        document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach((button) => {
            button.addEventListener('click', () => {
                const page = button.dataset.page;
                if (page) navigateTo(page);
            });
        });

        // Simula as leituras enquanto os dados reais da máquina não estão disponíveis.
        const load1 = document.getElementById('load1');
        const load2 = document.getElementById('load2');

        if (load1 && load2) {
            const simulationInterval = window.setInterval(() => {
                load1.textContent = (Math.random() * 15).toFixed(3);
                load2.textContent = (Math.random() * 15).toFixed(3);
            }, 1000);

            window.addEventListener('pagehide', () => {
                window.clearInterval(simulationInterval);
            }, { once: true });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeHome, { once: true });
    } else {
        initializeHome();
    }
})();
