import { Component } from 'react';
import { HiOutlineExclamationTriangle } from 'react-icons/hi2';

/**
 * RED DE SEGURIDAD DE LA PANTALLA.
 *
 * Sin esto, cualquier error al renderizar una página (o al descargar su fichero)
 * desmontaba TODO el árbol de React y dejaba la pantalla EN BLANCO, sin nada que
 * pulsar: había que recargar a mano. Con la barrera, el fallo se queda dentro del
 * área de contenido y el usuario tiene un botón para volver a intentarlo.
 *
 * `resetKey` (la ruta actual) hace que la barrera se rearme al navegar: si no,
 * una vez rota se quedaba rota aunque el usuario se fuera a otra pantalla.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prevProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
        <HiOutlineExclamationTriangle className="w-10 h-10 text-amber-500 mb-3" />
        <p className="text-lg font-semibold text-slate-800">No se pudo abrir esta pantalla</p>
        <p className="text-sm text-slate-500 mt-1 max-w-md">
          Suele pasar cuando el sistema se acaba de actualizar y la pestaña seguía con la versión
          anterior. Al recargar se coge la nueva.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="mt-4 px-4 py-2 bg-emerald-600 text-white rounded-xl text-sm border-none cursor-pointer hover:bg-emerald-700"
        >
          Recargar
        </button>
      </div>
    );
  }
}
