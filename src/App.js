import React, { useState, useEffect, useRef } from 'react';
import { supabase } from './supabaseClient';
import { PREGUNTAS, FIGURITAS } from './datos';
import './App.css';

// ============================================================================
// LOGÍSTICA MATEMÁTICA: GARANTIZA SINCRONIZACIÓN LOCAL SIN TOCAR LA DB
// ============================================================================

// Función para obtener las 5 preguntas y las 10 figuritas de la partida usando el código de sala como Semilla (Seed)
const obtenerComponentesPartida = (codigoSala) => {
  // Si no hay sala, devolvemos recortes por defecto para evitar roturas de render
  if (!codigoSala) {
    return {
      preguntas: PREGUNTAS.slice(0, 5),
      figuritasPool: FIGURITAS.slice(0, 10)
    };
  }

  // Convertimos el código alfanumérico (ej: "A7BX") en un número base único
  let seed = 0;
  for (let i = 0; i < codigoSala.length; i++) {
    seed += codigoSala.charCodeAt(i);
  }

  // Generador pseudoaleatorio determinista
  const pseudoRandom = () => {
    const x = Math.sin(seed++) * 10000;
    return x - Math.floor(x);
  };

  // 1. MEZCLAR Y RECORTAR PREGUNTAS (Exactamente 5)
  const indicesPreguntas = Array.from({ length: PREGUNTAS.length }, (_, i) => i);
  for (let i = indicesPreguntas.length - 1; i > 0; i--) {
    const j = Math.floor(pseudoRandom() * (i + 1));
    [indicesPreguntas[i], indicesPreguntas[j]] = [indicesPreguntas[j], indicesPreguntas[i]];
  }
  const preguntasSeleccionadas = indicesPreguntas.slice(0, 5).map(idx => PREGUNTAS[idx]);

  // 2. MEZCLAR Y RECORTAR FIGURITAS (Exactamente 10 para el álbum de esta partida)
  const indicesFiguritas = Array.from({ length: FIGURITAS.length }, (_, i) => i);
  for (let i = indicesFiguritas.length - 1; i > 0; i--) {
    const j = Math.floor(pseudoRandom() * (i + 1));
    [indicesFiguritas[i], indicesFiguritas[j]] = [indicesFiguritas[j], indicesFiguritas[i]];
  }
  const poolFiguritasSeleccionadas = indicesFiguritas.slice(0, 10).map(idx => FIGURITAS[idx]);

  return {
    preguntas: preguntasSeleccionadas,
    figuritasPool: poolFiguritasSeleccionadas
  };
};

// ============================================================================
// COMPONENTE PRINCIPAL
// ============================================================================
function App() {
  const [nombre, setNombre] = useState(() => localStorage.getItem('trivia_nombre') || '');
  const [codigoInput, setCodigoInput] = useState(''); 
  const [salaId, setSalaId] = useState(() => localStorage.getItem('trivia_sala_id') || '');           
  const [miRol, setMiRol] = useState(() => localStorage.getItem('trivia_mi_rol') || null);
  const [sala, setSala] = useState(null);
  
  // Estado de las figuritas obtenidas por el usuario (empieza vacío)
  const [misFigus, setMisFigus] = useState(() => {
    const guardadas = localStorage.getItem('trivia_mis_figus');
    return guardadas ? JSON.parse(guardadas) : [];
  });
  
  const [mensajeSobre, setMensajeSobre] = useState(null);
  const [rondaBloqueada, setRondaBloqueada] = useState(false);

  const [transicionando, setTransicionando] = useState(false);
  const preguntaActualRef = useRef(0);

  const [salasDisponibles, setSalasDisponibles] = useState([]);
  const [salaSeleccionada, setSalaSeleccionada] = useState(null);
  const canalRef = useRef(null);

  // Sincronización con LocalStorage
  useEffect(() => {
    localStorage.setItem('trivia_nombre', nombre);
  }, [nombre]);

  useEffect(() => {
    localStorage.setItem('trivia_mis_figus', JSON.stringify(misFigus));
  }, [misFigus]);

  // Extraemos las preguntas y figuritas exactas asignadas para esta sala mediante la semilla matemática
  const { preguntas: preguntasDeLaPartida, figuritasPool: FIGURITAS_PARTIDA } = obtenerComponentesPartida(salaId);

  // 1. LOBBY GLOBAL: Escuchar e interactuar con salas públicas en espera
  useEffect(() => {
    if (salaId) return;

    const traerSalasDisponibles = async () => {
      const { data, error } = await supabase
        .from('salas')
        .select('*')
        .eq('estado', 'esperando');
      
      if (!error && data) {
        setSalasDisponibles(data);
      }
    };
    traerSalasDisponibles();

    const canalLobby = supabase
      .channel('lobby-global')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'salas' }, (payload) => {
        if (payload.eventType === 'INSERT') {
          if (payload.new.estado === 'esperando') {
            setSalasDisponibles((prev) => [...prev, payload.new]);
          }
        } else if (payload.eventType === 'UPDATE') {
          if (payload.new.estado !== 'esperando' || payload.new.jugador2) {
            setSalasDisponibles((prev) => prev.filter(s => s.id !== payload.new.id));
          } else {
            setSalasDisponibles((prev) => prev.map(s => s.id === payload.new.id ? payload.new : s));
          }
        } else if (payload.eventType === 'DELETE') {
          setSalasDisponibles((prev) => prev.filter(s => s.id !== payload.old.id));
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(canalLobby);
    };
  }, [salaId]);

  // 2. ESCUCHAR ACTUALIZACIONES REAL-TIME DE LA PARTIDA ACTIVA
  useEffect(() => {
    if (!salaId) return;

    const idDeEstaSalaActual = salaId;

    const traerDatosIniciales = async () => {
      const { data } = await supabase.from('salas').select('*').eq('id', idDeEstaSalaActual).single();
      if (data) {
        setSala(data);
        preguntaActualRef.current = data.pregunta_actual;
        if (data.ganador_ronda) setRondaBloqueada(true);
      } else {
        limpiarSesionLocal();
      }
    };
    traerDatosIniciales();

    const idUnicoCanal = Math.random().toString(36).substring(7);

    const canal = supabase
      .channel(`sala-${idDeEstaSalaActual}-${idUnicoCanal}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'salas' }, 
        (payload) => {
          const idRealDeLaMesa = payload.new.id;
          if (idRealDeLaMesa !== idDeEstaSalaActual) return;

          const nuevaSala = payload.new;
          if (!nuevaSala) return;

          setSala(() => ({ ...nuevaSala }));
          
          if (nuevaSala.pregunta_actual !== preguntaActualRef.current) {
            setTransicionando(true);
            setMensajeSobre(null);
            setRondaBloqueada(false);
            
            setTimeout(() => {
              preguntaActualRef.current = nuevaSala.pregunta_actual;
              setTransicionando(false);
            }, 100);
          } else {
            if (nuevaSala.ganador_ronda) {
              setRondaBloqueada(true);
            } else {
              setRondaBloqueada(false);
              setMensajeSobre(null);
            }
          }
        }
      );

    canal.subscribe();
    canalRef.current = canal; 

    return () => { 
      supabase.removeChannel(canal); 
      canalRef.current = null;
    };
  }, [salaId]);

  const limpiarSesionLocal = () => {
    if (canalRef.current) {
      supabase.removeChannel(canalRef.current);
      canalRef.current = null;
    }

    localStorage.removeItem('trivia_sala_id');
    localStorage.removeItem('trivia_mi_rol');
    localStorage.removeItem('trivia_mis_figus'); // Vaciamos el álbum para el próximo reinicio limpio

    setSalaId('');
    setMiRol(null);
    setSala(null);
    setCodigoInput(''); 
    setMisFigus([]);
  };

  const crearSala = async () => {
    if (!nombre) return alert("Poné tu nombre");
    const idRandom = Math.random().toString(36).substring(2, 6).toUpperCase();
    
    await supabase.from('salas').insert([{
      id: idRandom,
      jugador1: nombre,
      estado: 'esperando',
      pregunta_actual: 0,
      puntos_j1: 0,
      puntos_j2: 0
    }]);

    localStorage.setItem('trivia_sala_id', idRandom);
    localStorage.setItem('trivia_mi_rol', 'j1');
    
    setSalaId(idRandom);
    setMiRol('j1');
  };

  const unirseASala = async (idParaUnirse = null) => {
    const idFinal = (idParaUnirse || codigoInput).toUpperCase();
    if (!nombre || !idFinal) return alert("Falta nombre o código");
    
    const { data: salaExiste } = await supabase.from('salas').select('*').eq('id', idFinal).single();
    if (!salaExiste) return alert("La sala no existe");

    const esReingresoJ2 = salaExiste.jugador2 === nombre;

    if (!esReingresoJ2 && (salaExiste.jugador2 || salaExiste.estado !== 'esperando')) {
      return alert("🚫 Esta sala ya está llena o en juego.");
    }

    if (!esReingresoJ2) {
      await supabase.from('salas').update({ 
        jugador2: nombre, 
        estado: 'jugando' 
      }).eq('id', idFinal);
    }

    localStorage.setItem('trivia_sala_id', idFinal);
    localStorage.setItem('trivia_mi_rol', 'j2');

    setMiRol('j2');
    setSalaId(idFinal); 
  };

  const responder = async (opcion) => {
    if (!sala || rondaBloqueada || sala.ganador_ronda || transicionando) return;
    
    const preguntaActual = preguntasDeLaPartida[sala.pregunta_actual];
    if (!preguntaActual) return;
    
    if (opcion === preguntaActual.correcta) {
      const nuevosPuntosJ1 = miRol === 'j1' ? sala.puntos_j1 + 1 : sala.puntos_j1;
      const nuevosPuntosJ2 = miRol === 'j2' ? sala.puntos_j2 + 1 : sala.puntos_j2;

      // PREMIO: Sacamos 2 figuritas aleatorias PERO del pool exclusivo de 10 de esta partida
      const f1 = FIGURITAS_PARTIDA[Math.floor(Math.random() * FIGURITAS_PARTIDA.length)];
      const f2 = FIGURITAS_PARTIDA[Math.floor(Math.random() * FIGURITAS_PARTIDA.length)];

      const updateData = {
        ganador_ronda: nombre,
        puntos_j1: nuevosPuntosJ1,
        puntos_j2: nuevosPuntosJ2
      };

      const { error } = await supabase.from('salas').update(updateData).eq('id', sala.id);

      if (!error) {
        setRondaBloqueada(true);
        setMensajeSobre([f1, f2]);
        setMisFigus(prev => [...prev, f1, f2]);
      } else {
        console.error("Error al actualizar en Supabase:", error);
      }
    } else {
      alert("❌ ¡Incorrecto! Intentá de nuevo.");
    }
  };

  const siguientePregunta = async () => {
    if (!sala || transicionando) return;
    
    setTransicionando(true);
    setMensajeSobre(null);
    setRondaBloqueada(false);

    if (sala.pregunta_actual + 1 >= preguntasDeLaPartida.length) {
      await supabase.from('salas').update({ estado: 'terminado' }).eq('id', sala.id);
    } else {
      await supabase.from('salas').update({
        pregunta_actual: sala.pregunta_actual + 1,
        ganador_ronda: null
      }).eq('id', sala.id);
    }
  };

  const abandonarPartida = async () => {
    if (window.confirm("¿Seguro que querés salir al menú principal? PERDERÁS tus figuritas guardadas.")) {
      if (miRol === 'j1' && sala?.estado === 'esperando') {
        await supabase.from('salas').delete().eq('id', salaId);
      }
      if (sala?.estado === 'jugando') {
        await supabase.from('salas').update({ estado: 'terminado' }).eq('id', salaId);
      }
      limpiarSesionLocal();
    }
  };

  let contenidoPantalla;

  // RENDER: MENÚ PRINCIPAL
  if (!salaId || !sala) {
    const haySalaExpandida = salaSeleccionada !== null;

    contenidoPantalla = (
      <div className="lobby">
        <h1>🏆 Trivia del Mundial 🏆</h1>
        
        {!haySalaExpandida && (
          <div className="bloque-crear-sala animate-fade-in">
            <input 
              type="text" 
              placeholder="Tu Nombre" 
              value={nombre} 
              onChange={e => setNombre(e.target.value)} 
            />
            <hr />
            <button onClick={crearSala} className="btn-principal">Crear Nueva Partida</button>
            <hr />
          </div>
        )}

        <div className="salas-disponibles-container">
          <h3>Salas Esperando Contrincante 🌐</h3>
          {salasDisponibles.length === 0 ? (
            <p className="sin-salas">No hay salas activas en este momento. ¡Creá una!</p>
          ) : (
            <div className="lista-salas">
              {salasDisponibles.map((s) => {
                const estaExpandida = salaSeleccionada === s.id;

                return (
                  <div key={s.id} className={`sala-card-item ${estaExpandida ? 'expandida' : ''}`}>
                    <div className="sala-info-header">
                      <div className="sala-detalles">
                        <span className="sala-creador">Anfitrión: <strong>{s.jugador1}</strong></span>
                        <span className="sala-codigo-badge">Código: <code>{s.id}</code></span>
                      </div>
                      
                      <button 
                        onClick={() => {
                          setSalaSeleccionada(estaExpandida ? null : s.id);
                          setCodigoInput(''); 
                        }} 
                        className="btn-jugar-activador"
                      >
                        {estaExpandida ? 'Cerrar ❌' : 'Jugar 🎮'}
                      </button>
                    </div>
                    
                    {estaExpandida && (
                      <div className="unirse-box-desplegable animate-slide-down">
                        <hr className="divisor-interno" />
                        
                        <div className="formulario-unirse-compacto">
                          <input 
                            type="text" 
                            placeholder="Ingresá tu Nombre" 
                            value={nombre} 
                            onChange={e => setNombre(e.target.value)} 
                            className="input-contextual"
                          />
                          
                          <div className="input-group-desplegable">
                            <input 
                              type="text" 
                              placeholder="Confirmar código de sala" 
                              value={codigoInput} 
                              onChange={e => setCodigoInput(e.target.value)} 
                            />
                            <button 
                              onClick={() => unirseASala(s.id)}
                              className="btn-unirse-confirmar"
                            >
                              Unirse
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

// RENDER: ESPERA EN LOBBY
  else if (sala.estado === 'esperando') {
    contenidoPantalla = (
      <div className="lobby-espera-container">
        {/* Tarjeta Principal */}
        <div className="lobby">
          <h2>Sala: <span className="codigo">{sala.id}</span></h2>
          <p>Pasale este código a tu amigo para jugar.</p>
          <div className="loader">⏳ Esperando al contrincante...</div>
          <button onClick={abandonarPartida} className="btn-abandonar">Volver al Menú 🏠</button>
        </div>

        {/* Indicador de carga externo (debajo de la card) */}
        <div className="loading-externo-box">
          <div className="spinner-pulso"></div>
          <p>Buscando rivales activos en la red...</p>
        </div>
      </div>
    );
  }

  // RENDER: FIN DEL JUEGO
  else if (sala.estado === 'terminado') {
    let mensajeGanador = "Empate 🤝";
    if (sala.puntos_j1 > sala.puntos_j2) {
      mensajeGanador = `Ganador: 🏆 <strong>${sala.jugador1}</strong>`;
    } else if (sala.puntos_j2 > sala.puntos_j1) {
      mensajeGanador = `Ganador: 🏆 <strong>${sala.jugador2}</strong>`;
    }

    contenidoPantalla = (
      <div className="lobby">
        <h2>🎉 ¡Fin del Juego! 🎉</h2>
        <p dangerouslySetInnerHTML={{ __html: mensajeGanador }}></p>
        <p>{sala.jugador1}: {sala.puntos_j1} puntos</p>
        <p>{sala.jugador2}: {sala.puntos_j2} puntos</p>
        
        <button onClick={() => {
          limpiarSesionLocal(); 
          window.location.reload();
        }} className="btn-principal">
          Volver al Inicio 🏠
        </button>
      </div>
    );
  }

  else {

    // Extraemos dinámicamente la pregunta actual de la tanda mezclada
    const pregunta = preguntasDeLaPartida[sala.pregunta_actual];

    // RENDER: MESA DE TRIVIA ACTIVA
    contenidoPantalla = (
      <div className="game-container">
        <div className="marcador">
          <span>
            <strong>{sala.jugador1}</strong> • <span>🎯 {sala.puntos_j1}</span>
          </span>
          <button onClick={abandonarPartida} className="btn-salir-mini">Salir 🚪</button>
          <span>
            <strong>{sala.jugador2 ? sala.jugador2 : 'Jugador 2'}</strong> • <span>🎯 {sala.puntos_j2}</span>
          </span>
        </div>

        <div className="trivia-card">
          {transicionando || !pregunta ? (
            <div className="loader-pregunta">Cargando siguiente pregunta...</div>
          ) : (
            <>
              <h3>Pregunta {sala.pregunta_actual + 1} de 5</h3>
              <h2>{pregunta.q}</h2>

              <div className="trivia-dinamica">
                <div className="contenedor-estatico-dom">
                  {!rondaBloqueada ? (
                    <>
                      <div className="opciones-grid">
                        {pregunta.opciones.map((opc, idx) => (
                          <button 
                            key={`opc-${sala.pregunta_actual}-${idx}`} 
                            onClick={() => responder(opc)} 
                            className="btn-opcion"
                          >
                            {opc}
                          </button>
                        ))}
                      </div>
                      <p className="trivia-recordatorio-sobres">
                          🎁 Por cada respuesta correcta te ganás <strong>2 figuritas</strong> para el álbum. ¡Apurate y conseguí las <strong>10</strong> para ganar!
                      </p>
                    </>
                  ) : (
                    <div className="ronda-resultado" key={`resultado-${sala.pregunta_actual}`}>
                      <p className="ganador-aviso">
                        <span>🚀 ¡</span>
                        <strong>{sala.ganador_ronda || "Alguien"}</strong>
                        <span> respondió primero!</span>
                      </p>
                      <button onClick={siguientePregunta} className="btn-siguiente">
                        Siguiente Pregunta ➡️
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="contenedor-sobre-estable" style={{ minHeight: mensajeSobre && !transicionando ? 'auto' : '0px' }}>
          {mensajeSobre && !transicionando && (
            <div key={`sobre-${sala.pregunta_actual}`} className="sobre-abierto animate-pop">
              <h3>¡Tu Sobre Trajo 2 Figuritas! 🎁</h3>
              <div className="figus-ganadas">
                {mensajeSobre.map((f, i) => (
                  <div key={`figu-ganada-${f.id}-${i}`} className="figu-card">
                    <img src={f.imagen} alt={f.name} className="figu-foto-card" /> 
                    <p>{f.name}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ÁLBUM DINÁMICO REFACTORIZADO: Muestra únicamente los slots de las 10 figuritas de esta partida */}
        <div className="mi-album">
          <h3>Tu Álbum de la Partida ({misFigus.length} obtenidas)</h3>
          <p style={{ fontSize: '0.85rem', color: '#aaa', marginTop: '-5px', marginBottom: '15px' }}>
            ¡Respondé bien para descubrir las 10 figuritas ocultas de esta sala!
          </p>
          <div className="album-grid">
            {FIGURITAS_PARTIDA.map(f => {
              const repetidas = misFigus.filter(mf => mf.id === f.id).length;
              return (
                <div key={`slot-${f.id}`} className={`slot ${repetidas > 0 ? 'activo' : ''}`}>
                  {repetidas > 0 ? (
                    <div key="con-figu" className="slot-interno">
                      <img src={f.imagen} alt={f.name} className="album-foto-slot" />
                      <p>{f.name}</p>
                      {repetidas > 1 && <span className="badge">x{repetidas}</span>}
                    </div>
                  ) : (
                    <div key="sin-figu" className="slot-interno">
                      {/* Al principio se renderizará oculto, mostrando solo su ID de slot */}
                      <span className="numero">#{f.id}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // 2. UN ÚNICO RETURN GLOBAL PARA TODA LA APP
  return (
    <div className="app-layout-global">
      
      {/* Acá se va a inyectar la pantalla que corresponda automáticamente */}
      {contenidoPantalla}

      {/* FOOTER GENERAL: Se escribe una sola vez y aparece siempre abajo */}
      <footer className="footer-creador">
        <p>Desarrollado por <span>Gimenez Ever</span> | © 2026</p>
      </footer>

    </div>
  );
}

export default App;